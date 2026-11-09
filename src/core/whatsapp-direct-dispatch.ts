/**
 * Individual WhatsApp dispatch: POST /v1/dispatch/{project}/whatsapp-direct.
 *
 * Same envelope, per-project key and idempotency rules as the generic email route, but the
 * destination is one E.164 number supplied by the product. Delivery reuses the WAHA text
 * transport and a D1 receipt per event; hourly limits per project and per recipient are
 * enforced from the receipts, with only a keyed fingerprint of the number ever stored.
 */
import {sendWahaText,wahaTextEndpoint,type DeliveryResult} from './channels.js';
import {equalSecret,limitedJson} from './email-dispatch.js';
import {plainObject} from './email-contracts.js';
import type {NotifyDatabase} from './group-routing.js';
import {claimDirect,countRecentDirect,finishDirect,readDirect,type DirectState} from './whatsapp-direct-receipts.js';
import {maskRecipient,parseWhatsAppDirectEvent,parseWhatsAppDirectPolicy,recipientChatId,renderWhatsAppDirectText,
  type WhatsAppDirectPolicy} from './whatsapp-direct-contracts.js';

export interface WhatsAppDirectEnv {
  [key:string]:unknown;
  WHATSAPP_DIRECT_DISPATCH_ENABLED?:string; WHATSAPP_DIRECT_PROJECTS_JSON?:string;
  WAHA_BASE_URL?:string; WAHA_API_KEY?:string; WAHA_SESSION?:string;
  NOTIFY_DB?:NotifyDatabase;
}
export const WHATSAPP_DIRECT_ROUTE=/^\/v1\/dispatch\/([a-z][a-z0-9-]{1,48})\/whatsapp-direct$/;
const MAX_INPUT_BYTES=8192;
const WINDOW_MS=3600000;

const reply=(status:number,payload:object,headers:Record<string,string>={})=>new Response(JSON.stringify(payload),{
  status,headers:{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff',...headers}
});
async function hmacHex(key:string,value:string):Promise<string>{
  const k=await crypto.subtle.importKey('raw',new TextEncoder().encode(key),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const digest=new Uint8Array(await crypto.subtle.sign('HMAC',k,new TextEncoder().encode(value)));
  return Array.from(digest,b=>b.toString(16).padStart(2,'0')).join('');
}
/** Operational trace: project, event id (already a hash), masked number and outcome only. */
function trace(project:string,eventId:string,recipient:string,outcome:string):void{
  console.info('notify.whatsapp_direct',{project,eventId,recipient:maskRecipient(recipient),outcome});
}

export async function dispatchWhatsAppDirect(request:Request,env:WhatsAppDirectEnv,fetchImpl:typeof fetch=fetch,now=Date.now()):Promise<Response>{
  if(request.method!=='POST')return reply(405,{error:'METHOD_NOT_ALLOWED'});
  const project=new URL(request.url).pathname.match(WHATSAPP_DIRECT_ROUTE)?.[1];
  if(!project)return reply(404,{error:'NOT_FOUND'});
  // Keys are scoped to this channel: an email or group WhatsApp key never authorizes a 1:1 message.
  const key=env['WHATSAPP_DIRECT_'+project.replaceAll('-','_').toUpperCase()+'_INGEST_KEY'];
  if(typeof key!=='string'||key.length<32||key.length>256)return reply(503,{error:'INGEST_NOT_CONFIGURED'});
  const received=request.headers.get('x-notify-auth')||'';
  if(received.length>256||!equalSecret(key,received))return reply(401,{error:'UNAUTHORIZED'});
  let policy:WhatsAppDirectPolicy|null,declared:boolean;
  try{
    const policies=plainObject(JSON.parse(env.WHATSAPP_DIRECT_PROJECTS_JSON||'{}'));
    if(!policies)throw Error('INVALID_POLICY');
    declared=Object.hasOwn(policies,project);
    policy=declared?parseWhatsAppDirectPolicy(policies[project]):null;
  }catch{return reply(503,{error:'WHATSAPP_DIRECT_NOT_CONFIGURED'});}
  // A valid key for an undeclared project is a policy refusal, not a configuration outage.
  if(!declared)return reply(403,{error:'PROJECT_NOT_ALLOWED'});
  if(env.WHATSAPP_DIRECT_DISPATCH_ENABLED!=='true'||!policy)return reply(503,{error:'CHANNEL_DISABLED'});
  const db=env.NOTIFY_DB,baseUrl=env.WAHA_BASE_URL,apiKey=env.WAHA_API_KEY,session=env.WAHA_SESSION;
  if(!db||!baseUrl||!apiKey||!session)return reply(503,{error:'WHATSAPP_DIRECT_NOT_CONFIGURED'});
  if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')||''))return reply(415,{error:'JSON_REQUIRED'});
  const length=request.headers.get('content-length');
  if(length&&(!/^\d+$/.test(length)||Number(length)>MAX_INPUT_BYTES))return reply(413,{error:'BODY_TOO_LARGE'});
  let event;
  try{event=parseWhatsAppDirectEvent(await limitedJson(request,MAX_INPUT_BYTES),project,now);}
  catch(error){
    return error instanceof Error&&error.message==='BODY_TOO_LARGE'?reply(413,{error:'BODY_TOO_LARGE'}):reply(400,{error:'INVALID_WHATSAPP_EVENT'});
  }
  // Invalid provider settings fail before any claim, so no lease is left behind.
  const target={baseUrl,apiKey,session,chatId:recipientChatId(event.recipient)};
  let endpoint:string;
  try{endpoint=wahaTextEndpoint(target);}catch{return reply(503,{error:'WHATSAPP_DIRECT_NOT_CONFIGURED'});}
  let token:string;
  try{
    // Keyed fingerprints: a copied ledger reveals neither short message content nor phone numbers.
    const hash=await hmacHex(key,JSON.stringify(event));
    const recipientHash=await hmacHex(key,'recipient:'+event.recipient);
    const saved=await readDirect(db,project,event.id);
    if(saved&&saved.payload_hash!==hash)return reply(409,{error:'EVENT_ID_REUSED'});
    if(saved?.state==='accepted'){trace(project,event.id,event.recipient,'duplicate');
      return reply(202,{accepted:true,project,channel:'whatsapp_direct',eventId:event.id});}
    if(saved?.state==='rejected')return reply(502,{error:'PROVIDER_REJECTED'});
    // Limits are read from other events' receipts before any claim: a refused event leaves no
    // receipt and consumes no attempt, and a retry of this event never counts against itself.
    const recent=await countRecentDirect(db,project,event.id,recipientHash,now-WINDOW_MS);
    const limited=recent.project>=policy.limits.perHour?'project':recent.recipient>=policy.limits.perRecipientPerHour?'recipient':null;
    if(limited){trace(project,event.id,event.recipient,'rate_limited_'+limited);
      return reply(429,{error:'RATE_LIMITED',scope:limited},{'retry-after':'60'});}
    const claim=await claimDirect(db,project,event.id,hash,recipientHash,Date.parse(event.expiresAt),now);
    if(claim.state==='accepted'){trace(project,event.id,event.recipient,'duplicate');
      return reply(202,{accepted:true,project,channel:'whatsapp_direct',eventId:event.id});}
    if(claim.state==='rejected')return reply(502,{error:'PROVIDER_REJECTED'});
    if(claim.state!=='claimed')return reply(503,{error:'DELIVERY_UNRESOLVED'});
    token=claim.token;
  }catch(error){
    return error instanceof Error&&error.message==='EVENT_ID_REUSED'
      ?reply(409,{error:'EVENT_ID_REUSED'}):reply(503,{error:'RECEIPT_UNAVAILABLE'});
  }
  let result:DeliveryResult;
  try{result=await sendWahaText(target,renderWhatsAppDirectText(event.message),fetchImpl,endpoint);}
  catch{result={accepted:false,retryable:false,code:'PROVIDER_REJECTED'};}
  const state:DirectState=result.accepted?'accepted':result.retryable?'retry':'rejected';
  try{await finishDirect(db,project,event.id,token,state,now);}
  catch{return reply(503,{error:'RECEIPT_UNAVAILABLE'});}
  trace(project,event.id,event.recipient,result.code.toLowerCase());
  if(result.accepted)return reply(202,{accepted:true,project,channel:'whatsapp_direct',eventId:event.id});
  return result.retryable?reply(503,{error:result.code}):reply(502,{error:'PROVIDER_REJECTED'});
}
