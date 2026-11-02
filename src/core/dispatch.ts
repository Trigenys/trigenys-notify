/**
 * Trigenys Notify: central provider-owned WhatsApp dispatch.
 *
 * Xeption (and future products) retain their durable source event/outbox until
 * Notify has a first-party durable queue. They send a versioned event here.
 * Trigenys Notify owns provider credentials and the outgoing WAHA request.
 *
 * Not enabled in production until all Cloudflare secrets have been configured
 * AND WAHA_DISPATCH_ENABLED=true. No client-side access.
 */
import {WahaAdapter} from "./channels.js";
import {parseNotifyEvent,InvalidNotifyEvent} from "./contracts.js";
import {prepareDelivery,TenantPolicyError} from "./tenants.js";
import {resolveProjectGroups,projectHasCandidates,syncWahaGroups,type NotifyDatabase,type ProjectGroup} from "./group-routing.js";
import {deliveryPlan,claimRecipient,finishRecipient} from './whatsapp-receipts.js';

export interface DispatchEnv {
  WAHA_DISPATCH_ENABLED?:string;
  XEPTION_NOTIFY_INGEST_KEY?:string;
  WAHA_BASE_URL?:string;
  WAHA_API_KEY?:string;
  WAHA_SESSION?:string;
  WAHA_STAFF_GROUP_ID?:string;
  WAHA_FALLBACK_PROJECTS?:string;
  WAHA_ROUTING_REQUIRED?:string;
  NOTIFY_DB?:NotifyDatabase;
}

const json=(status:number,error:string):Response=>new Response(JSON.stringify({error}),{
  status,headers:{
    "content-type":"application/json; charset=utf-8",
    "cache-control":"no-store",
    "x-content-type-options":"nosniff"
  }
});
/** Constant-work string comparison for pre-shared server authentication. */
function equalSecret(expected:string,received:string):boolean {
  const encoder=new TextEncoder();
  const x=encoder.encode(expected),y=encoder.encode(received);
  let different=x.length ^ y.length;
  for(let i=0;i<Math.max(x.length,y.length);i++){
    different |= (x[i]??0) ^ (y[i]??0);
  }
  return different===0;
}
const MAX_INPUT_BYTES=4096;
const ALLOWED_TYPES=new Set([
  "inventory.stock_low","inventory.stock_out","catalog.product_missing_image",
  "barter.requested","marketplace.listing_created",
  "order.created","order.paid","barter.voucher_expiring","cash_report.closed","finance.debt_overdue"
]);

/**
 * Single route POST /v1/dispatch/xeption/whatsapp.
 * Auth: x-notify-auth: <per-source secret>.
 * Never forwards raw content or client-controlled destinations to WAHA.
 */
export async function dispatchXeptionWhatsApp(
  request:Request,env:DispatchEnv,fetchImpl:typeof fetch=fetch
):Promise<Response>{
  if(request.method!=="POST")return json(405,"METHOD_NOT_ALLOWED");
  const key=env.XEPTION_NOTIFY_INGEST_KEY??"";
  if(key.length<32)return json(503,"INGEST_NOT_CONFIGURED");
  if(!equalSecret(key,request.headers.get("x-notify-auth")??""))
    return json(401,"UNAUTHORIZED");
  if(env.WAHA_DISPATCH_ENABLED!=="true")return json(503,"CHANNEL_DISABLED");
  if(!request.headers.get("content-type")?.toLowerCase().startsWith("application/json"))
    return json(415,"JSON_REQUIRED");
  if(Number(request.headers.get("content-length")||0)>MAX_INPUT_BYTES)
    return json(413,"BODY_TOO_LARGE");
  let decoded:unknown;
  try{
    const raw=await request.text();
    if(new TextEncoder().encode(raw).length>MAX_INPUT_BYTES)
      return json(413,"BODY_TOO_LARGE");
    decoded=JSON.parse(raw);
  }catch{return json(400,"INVALID_JSON");}
  let message,event;
  try{
    event=parseNotifyEvent(decoded);
    if(event.project!=="xeption" || !ALLOWED_TYPES.has(event.type))
      return json(400,"EVENT_NOT_ALLOWED");
    // Absolute site origin is pinned to Xeption; input cannot redirect actions.
    message=prepareDelivery(event,{
      project:"xeption",allowedActionOrigins:["https://www.xeptionetwork.shop"],
      channels:{whatsapp_waha:true}
    },"whatsapp_waha");
  }catch(e){
    if(e instanceof InvalidNotifyEvent || e instanceof TenantPolicyError)
      return json(400,"INVALID_EVENT");
    return json(400,"INVALID_EVENT");
  }
  if(!env.WAHA_BASE_URL || !env.WAHA_API_KEY || !env.WAHA_SESSION)
    return json(503,"WAHA_NOT_CONFIGURED");
  const db=env.NOTIFY_DB;
  if(!db&&env.WAHA_ROUTING_REQUIRED==='true')return json(503,'GROUP_REGISTRY_UNAVAILABLE');
  const fallback:ProjectGroup|undefined=env.WAHA_STAFF_GROUP_ID&&
    (env.WAHA_FALLBACK_PROJECTS??(db?'':'xeption')).split(',').map(s=>s.trim()).includes('xeption')
    ?{session:env.WAHA_SESSION,groupId:env.WAHA_STAFF_GROUP_ID}:undefined;
  let recipients:ProjectGroup[]=[];
  let discoveryAvailable=false;
  if(db){
    try{await syncWahaGroups(env,fetchImpl);discoveryAvailable=true;}
    catch{console.warn('notify.waha_discovery_unavailable');}
    try{
      recipients=await resolveProjectGroups(db,'xeption');
      // A provider or database outage is never interpreted as "no group".
      // Pending approvals and revoked routes also block a silent fallback.
      if(!recipients.length&&fallback&&discoveryAvailable&&
        !await projectHasCandidates(db,'xeption',env.WAHA_SESSION))recipients=[fallback];
    }catch{return json(503,'GROUP_ROUTE_UNAVAILABLE');}
  }else if(fallback)recipients=[fallback]; // Explicit legacy migration mode only.
  let plan=recipients;
  if(db){
    try{
      const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',
        new TextEncoder().encode(JSON.stringify(event))))).map(b=>b.toString(16).padStart(2,'0')).join('');
      const saved=await deliveryPlan(db,'xeption',message.eventId,hash,recipients);
      if(!saved)return json(503,'GROUP_ROUTE_UNASSIGNED');
      plan=saved;
    }catch(error){
      return error instanceof Error&&error.message==='EVENT_ID_REUSED'
        ?json(409,'EVENT_ID_REUSED'):json(503,'DELIVERY_REGISTRY_UNAVAILABLE');
    }
  }
  if(!plan.length)return json(503,'GROUP_ROUTE_UNASSIGNED');
  const allowed=new Set(recipients.map(r=>JSON.stringify([r.session,r.groupId])));
  const baseUrl=env.WAHA_BASE_URL,apiKey=env.WAHA_API_KEY;
  let accepted=0,failed=0,retryable=false,errorCode='PROVIDER_REJECTED';
  const deliver=async(recipient:ProjectGroup)=>{
    // Recheck authorization on every retry; old alerts never acquire new groups.
    if(!allowed.has(JSON.stringify([recipient.session,recipient.groupId])))return;
    let token:string|undefined;
    try{
      if(db){
        const claim=await claimRecipient(db,'xeption',message.eventId,recipient);
        if(claim.state==='accepted'){accepted++;return;}
        if(claim.state==='busy'){failed++;retryable=true;errorCode='DELIVERY_IN_PROGRESS';return;}
        token=claim.token;
      }
      const adapter=new WahaAdapter({baseUrl,apiKey,session:recipient.session,groupChatId:recipient.groupId},fetchImpl);
      const result=await adapter.send(message);
      if(db&&token)await finishRecipient(db,'xeption',message.eventId,recipient,token,result.accepted);
      if(result.accepted)accepted++;
      else{failed++;retryable||=result.retryable;errorCode=result.code;}
    }catch{failed++;retryable=true;errorCode='DELIVERY_REGISTRY_UNAVAILABLE';}
  };
  // Bound provider concurrency and isolate failures per destination.
  for(let i=0;i<plan.length;i+=4)await Promise.all(plan.slice(i,i+4).map(deliver));
  if(failed)return json(retryable?503:502,errorCode);
  return new Response(JSON.stringify({accepted:true,project:'xeption',channel:'whatsapp_waha',
    eventId:message.eventId,recipients:plan.length,acceptedRecipients:accepted
  }),{status:202,headers:{'content-type':'application/json','cache-control':'no-store'}});
}

