/**
 * Generic product-to-group WhatsApp dispatch: POST /v1/dispatch/{project}/whatsapp.
 *
 * Same envelope and per-project authentication as the generic email route. Messages go
 * only to `@g.us` groups declared for the project in WHATSAPP_PROJECTS_JSON; the request
 * never chooses a destination. Delivery reuses the WAHA adapter and the existing D1
 * per-recipient receipts, so retries do not resend to groups that already accepted.
 */
import {WahaAdapter} from './channels.js';
import {equalSecret,limitedJson} from './email-dispatch.js';
import {plainObject} from './email-contracts.js';
import type {NotifyDatabase,ProjectGroup} from './group-routing.js';
import {deliveryPlan,claimRecipient,finishRecipient} from './whatsapp-receipts.js';
import {parseWhatsAppEvent,parseWhatsAppPolicy,renderWhatsAppText,type WhatsAppProjectPolicy} from './whatsapp-contracts.js';

export interface WhatsAppEnv {
  [key:string]:unknown;
  WAHA_DISPATCH_ENABLED?:string; WHATSAPP_PROJECTS_JSON?:string;
  WAHA_BASE_URL?:string; WAHA_API_KEY?:string; WAHA_SESSION?:string;
  NOTIFY_DB?:NotifyDatabase;
}
export const WHATSAPP_ROUTE=/^\/v1\/dispatch\/([a-z][a-z0-9-]{1,48})\/whatsapp$/;
/** Products with a dedicated, differently-shaped route keep it; they never share its receipts. */
const RESERVED=new Set(['xeption','atelier']);
const MAX_INPUT_BYTES=8192;

const reply=(status:number,payload:object)=>new Response(JSON.stringify(payload),{
  status,headers:{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'}
});

export async function dispatchWhatsApp(request:Request,env:WhatsAppEnv,fetchImpl:typeof fetch=fetch,now=Date.now()):Promise<Response>{
  if(request.method!=='POST')return reply(405,{error:'METHOD_NOT_ALLOWED'});
  const project=new URL(request.url).pathname.match(WHATSAPP_ROUTE)?.[1];
  if(!project||RESERVED.has(project))return reply(404,{error:'NOT_FOUND'});
  // WhatsApp keys are scoped to this channel; an email key never authorizes a group message.
  const key=env['WHATSAPP_'+project.replaceAll('-','_').toUpperCase()+'_INGEST_KEY'];
  if(typeof key!=='string'||key.length<32||key.length>256)return reply(503,{error:'INGEST_NOT_CONFIGURED'});
  const received=request.headers.get('x-notify-auth')||'';
  if(received.length>256||!equalSecret(key,received))return reply(401,{error:'UNAUTHORIZED'});
  let policy:WhatsAppProjectPolicy|null;
  try{
    const policies=plainObject(JSON.parse(env.WHATSAPP_PROJECTS_JSON||'{}'));
    if(!policies)throw Error('INVALID_POLICY');
    policy=Object.hasOwn(policies,project)?parseWhatsAppPolicy(policies[project],env.WAHA_SESSION):null;
  }catch{return reply(503,{error:'WHATSAPP_NOT_CONFIGURED'});}
  if(env.WAHA_DISPATCH_ENABLED!=='true'||!policy)return reply(503,{error:'CHANNEL_DISABLED'});
  if(!policy.groups.length)return reply(503,{error:'GROUP_ROUTE_UNASSIGNED'});
  const db=env.NOTIFY_DB,baseUrl=env.WAHA_BASE_URL,apiKey=env.WAHA_API_KEY;
  if(!db||!baseUrl||!apiKey)return reply(503,{error:'WHATSAPP_NOT_CONFIGURED'});
  if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')||''))return reply(415,{error:'JSON_REQUIRED'});
  const length=request.headers.get('content-length');
  if(length&&(!/^\d+$/.test(length)||Number(length)>MAX_INPUT_BYTES))return reply(413,{error:'BODY_TOO_LARGE'});
  let event;
  try{event=parseWhatsAppEvent(await limitedJson(request,MAX_INPUT_BYTES),project,now,policy.allowedLinkOrigins);}
  catch(error){
    const code=error instanceof Error?error.message:'';
    if(code==='BODY_TOO_LARGE')return reply(413,{error:'BODY_TOO_LARGE'});
    return reply(400,{error:code==='LINK_ORIGIN_DENIED'?'LINK_ORIGIN_DENIED':'INVALID_WHATSAPP_EVENT'});
  }
  let plan:ProjectGroup[];
  try{
    // Keyed fingerprint: a copied ledger does not allow guessing short message content offline.
    const fingerprintKey=await crypto.subtle.importKey('raw',new TextEncoder().encode(key),{name:'HMAC',hash:'SHA-256'},false,['sign']);
    const digest=new Uint8Array(await crypto.subtle.sign('HMAC',fingerprintKey,new TextEncoder().encode(JSON.stringify(event))));
    const hash=Array.from(digest,b=>b.toString(16).padStart(2,'0')).join('');
    const saved=await deliveryPlan(db,project,event.id,hash,policy.groups);
    if(!saved)return reply(503,{error:'GROUP_ROUTE_UNASSIGNED'});
    plan=saved;
  }catch(error){
    return error instanceof Error&&error.message==='EVENT_ID_REUSED'
      ?reply(409,{error:'EVENT_ID_REUSED'}):reply(503,{error:'DELIVERY_REGISTRY_UNAVAILABLE'});
  }
  // The recipient list is frozen per event; a group removed from the policy since is skipped on retry.
  const allowed=new Set(policy.groups.map(g=>JSON.stringify([g.session,g.groupId])));
  const text=renderWhatsAppText(event.message);
  let accepted=0,failed=0,skipped=0,retryable=false,errorCode='PROVIDER_REJECTED';
  const deliver=async(recipient:ProjectGroup)=>{
    if(!allowed.has(JSON.stringify([recipient.session,recipient.groupId]))){skipped++;return;}
    let adapter:WahaAdapter;
    // Invalid provider settings fail before a claim, so no lease is left behind.
    try{adapter=new WahaAdapter({baseUrl,apiKey,session:recipient.session,groupChatId:recipient.groupId},fetchImpl);}
    catch{failed++;retryable=true;errorCode='WHATSAPP_NOT_CONFIGURED';return;}
    try{
      const claim=await claimRecipient(db,project,event.id,recipient);
      if(claim.state==='accepted'){accepted++;return;}
      if(claim.state==='busy'){failed++;retryable=true;errorCode='DELIVERY_IN_PROGRESS';return;}
      const result=await adapter.sendText(text);
      await finishRecipient(db,project,event.id,recipient,claim.token,result.accepted);
      if(result.accepted)accepted++;
      else{failed++;retryable||=result.retryable;errorCode=result.code;}
    }catch{failed++;retryable=true;errorCode='DELIVERY_REGISTRY_UNAVAILABLE';}
  };
  for(let i=0;i<plan.length;i+=4)await Promise.all(plan.slice(i,i+4).map(deliver));
  if(failed)return reply(retryable?503:502,{error:errorCode});
  if(!accepted&&skipped)return reply(503,{error:'GROUP_ROUTE_UNASSIGNED'});
  return reply(202,{accepted:true,project,channel:'whatsapp_waha',eventId:event.id,
    recipients:plan.length,acceptedRecipients:accepted});
}
