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
import {resolveProjectGroup,type NotifyDatabase} from "./group-routing.js";

export interface DispatchEnv {
  WAHA_DISPATCH_ENABLED?:string;
  XEPTION_NOTIFY_INGEST_KEY?:string;
  WAHA_BASE_URL?:string;
  WAHA_API_KEY?:string;
  WAHA_SESSION?:string;
  WAHA_STAFF_GROUP_ID?:string;
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
  "barter.requested","marketplace.listing_created"
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
  let message;
  try{
    const event=parseNotifyEvent(decoded);
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
  // D1 is the authoritative routing source when provisioned. Without D1
  // the current Xeption-only legacy route remains operational for migration.
  let session=env.WAHA_SESSION,groupId=env.WAHA_STAFF_GROUP_ID;
  if(env.NOTIFY_DB) {
    try {
      const route=await resolveProjectGroup(env.NOTIFY_DB,"xeption");
      if(!route)return json(503,"GROUP_ROUTE_UNASSIGNED");
      session=route.session;groupId=route.groupId;
    }catch{return json(503,"GROUP_ROUTE_UNAVAILABLE");}
  }
  if(!env.WAHA_BASE_URL || !env.WAHA_API_KEY || !session || !groupId)
    return json(503,"WAHA_NOT_CONFIGURED");
  let channel:WahaAdapter;
  try{
    channel=new WahaAdapter({
      baseUrl:env.WAHA_BASE_URL,apiKey:env.WAHA_API_KEY,
      session,groupChatId:groupId
    },fetchImpl);
  }catch{return json(503,"WAHA_INVALID_CONFIG");}
  const result=await channel.send(message);
  if(result.accepted)return new Response(JSON.stringify({
    accepted:true,project:"xeption",channel:"whatsapp_waha",eventId:message.eventId
  }),{status:202,headers:{"content-type":"application/json","cache-control":"no-store"}});
  // Distinguish retryable from permanent failures for the source outbox.
  // Never include provider body, API key, group ID or client content.
  return json(result.retryable?503:502,result.code);
}
