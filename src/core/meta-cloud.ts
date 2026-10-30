/**
 * Official Meta Cloud API adapter for Atelier Maître customer notifications.
 *
 * Provider credentials live ONLY in the Notify Worker secrets. Atelier keeps
 * consent, approved-template policy, quotas, transactional outbox and inbound
 * Meta webhook correlation until a separately verified cutover.
 *
 * No automatic retry: Meta does not accept an idempotency key. An ambiguous
 * transport failure MUST NOT be retried blindly by the caller.
 */
export const ATELIER_META_TEMPLATES = {
  APPOINTMENT_CONFIRMED: {name:"am_appointment_confirmed_v1", variables:4},
  APPOINTMENT_REMINDER: {name:"am_appointment_reminder_v1", variables:4},
  SERVICE_ORDER_RECEIVED: {name:"am_service_order_received_v1", variables:4},
  QUOTE_APPROVAL_REQUESTED: {name:"am_quote_approval_v1", variables:4, button:true},
  VEHICLE_READY: {name:"am_vehicle_ready_v1", variables:3},
  INVOICE_AVAILABLE: {name:"am_invoice_available_v1", variables:4, button:true},
  INVOICE_PAYMENT_REMINDER: {name:"am_invoice_reminder_v1", variables:4},
  PAYMENT_CONFIRMED: {name:"am_payment_confirmed_v1", variables:4}
} as const;

type EventType = keyof typeof ATELIER_META_TEMPLATES;
export interface MetaTemplateDispatch {
  eventId:string;
  eventType:EventType;
  to:string;
  templateName:string;
  language:"fr"|"en";
  variables:string[];
  buttons?:Array<{index:number;urlSuffix:string}>;
}

export interface AtelierMetaEnv {
  ATELIER_META_DISPATCH_ENABLED?:string;
  ATELIER_META_DISPATCH_MODE?:string;
  ATELIER_META_PILOT_RECIPIENTS?:string;
  ATELIER_NOTIFY_INGEST_KEY?:string;
  ATELIER_META_APPROVED_TEMPLATES?:string;
  META_CLOUD_ACCESS_TOKEN?:string;
  META_CLOUD_PHONE_NUMBER_ID?:string;
  META_CLOUD_API_VERSION?:string;
}

const MAX_INPUT_BYTES=4096;
const encoder=new TextEncoder();

function reply(status:number,data:Record<string,unknown>):Response {
  return new Response(JSON.stringify(data),{status,headers:{
    "content-type":"application/json; charset=utf-8",
    "cache-control":"no-store",
    "x-content-type-options":"nosniff",
    "referrer-policy":"no-referrer"
  }});
}

function equalSecret(a:string,b:string):boolean {
  const x=encoder.encode(a),y=encoder.encode(b);
  let diff=x.length^y.length;
  for(let i=0;i<Math.max(x.length,y.length);i++) diff|=(x[i]??0)^(y[i]??0);
  return diff===0;
}
function object(value:unknown):value is Record<string,unknown> {
  return value!==null && typeof value==="object" && !Array.isArray(value);
}
function validTemplateValue(value:unknown):value is string {
  return typeof value==="string" && value.trim().length>0 && value.length<=250 &&
    !/[\r\n\t]/.test(value) && !/ {5}/.test(value);
}
function parsePayload(value:unknown):MetaTemplateDispatch|null {
  if(!object(value))return null;
  const allowed=new Set(["eventId","eventType","to","templateName","language","variables","buttons"]);
  if(Object.keys(value).some(key=>!allowed.has(key)))return null;
  if(typeof value.eventId!=="string" || !/^[a-zA-Z0-9._:-]{1,128}$/.test(value.eventId))
    return null;
  if(typeof value.eventType!=="string" ||
    !Object.hasOwn(ATELIER_META_TEMPLATES,value.eventType))return null;
  const eventType=value.eventType as EventType;
  const expected=ATELIER_META_TEMPLATES[eventType];
  if(value.templateName!==expected.name)return null;
  if(value.language!=="fr" && value.language!=="en")return null;
  if(typeof value.to!=="string" || !/^\+[1-9]\d{7,14}$/.test(value.to))
    return null;
  if(!Array.isArray(value.variables) || value.variables.length!==expected.variables ||
    !value.variables.every(validTemplateValue))return null;
  let buttons:MetaTemplateDispatch["buttons"];
  if("button" in expected) {
    if(!Array.isArray(value.buttons) || value.buttons.length!==1)return null;
    const b:unknown=value.buttons[0];
    if(!object(b) || Object.keys(b).some(k=>k!=="index"&&k!=="urlSuffix") ||
      b.index!==0 || typeof b.urlSuffix!=="string" ||
      !/^[A-Za-z0-9_-]{16,256}$/.test(b.urlSuffix))return null;
    buttons=[{index:0,urlSuffix:b.urlSuffix}];
  } else if(value.buttons!==undefined && (!Array.isArray(value.buttons)||value.buttons.length!==0)) {
    return null;
  }
  return {
    eventId:value.eventId,eventType,to:value.to,templateName:expected.name,
    language:value.language,variables:value.variables as string[],
    ...(buttons?{buttons}:{})
  };
}

function validProviderConfig(env:AtelierMetaEnv):boolean {
  return Boolean(env.META_CLOUD_ACCESS_TOKEN && env.META_CLOUD_ACCESS_TOKEN.length>=16 &&
    env.META_CLOUD_PHONE_NUMBER_ID && /^\d{1,32}$/.test(env.META_CLOUD_PHONE_NUMBER_ID) &&
    env.META_CLOUD_API_VERSION && /^v\d{1,3}\.\d{1,2}$/.test(env.META_CLOUD_API_VERSION));
}
type ProviderResult =
  | {accepted:true;providerMessageId:string}
  | {accepted:false;code:string;status:number;retryable:boolean};

function metaErrorCode(payload:unknown):number|null {
  if(!object(payload)||!object(payload.error))return null;
  return typeof payload.error.code==="number" && Number.isInteger(payload.error.code)
    ?payload.error.code:null;
}

/** Stateless transport; never logs tokens, recipients, template variables or Meta errors. */
export class MetaCloudApiAdapter {
  private readonly endpoint:string;
  constructor(private readonly env:AtelierMetaEnv,private readonly http:typeof fetch=fetch) {
    if(!validProviderConfig(env))throw new Error("META_PROVIDER_NOT_CONFIGURED");
    this.endpoint="https://graph.facebook.com/"+
      env.META_CLOUD_API_VERSION+"/"+env.META_CLOUD_PHONE_NUMBER_ID+"/messages";
  }
  async sendTemplate(message:MetaTemplateDispatch):Promise<ProviderResult> {
    const components:Record<string,unknown>[]=[{
      type:"body",parameters:message.variables.map(text=>({type:"text",text}))
    }];
    for(const button of message.buttons??[]){
      components.push({type:"button",sub_type:"url",index:String(button.index),
        parameters:[{type:"text",text:button.urlSuffix}]});
    }
    const payload={
      messaging_product:"whatsapp",recipient_type:"individual",to:message.to.slice(1),
      type:"template",template:{name:message.templateName,language:{code:message.language},components}
    };
    let response:Response;
    try {
      const http=this.http; // Cloudflare workerd: do not bind native fetch as a method
      response=await http(this.endpoint,{
        method:"POST",headers:{
          "Authorization":"Bearer "+this.env.META_CLOUD_ACCESS_TOKEN,
          "Content-Type":"application/json","Accept":"application/json"
        },body:JSON.stringify(payload),signal:AbortSignal.timeout(10000)
      });
    }catch{
      // Ambiguous outcome: Meta may have accepted the message. Do NOT auto-retry.
      return {accepted:false,code:"UNKNOWN_OUTCOME",status:502,retryable:false};
    }
    let parsed:unknown;
    try {
      const text=await response.text();
      parsed=text.length<=8192?JSON.parse(text):null;
    }catch {parsed=null;}
    if(response.ok){
      const messages=object(parsed)&&Array.isArray(parsed.messages)?parsed.messages:[];
      const first=messages[0];
      if(object(first)&&typeof first.id==="string"&&first.id.length>0&&first.id.length<=256)
        return {accepted:true,providerMessageId:first.id};
      return {accepted:false,code:"UNKNOWN_OUTCOME",status:502,retryable:false};
    }
    const code=metaErrorCode(parsed);
    if(response.status===429 || [4,80007,130429,131056].includes(code??-1))
      return {accepted:false,code:"RATE_LIMITED",status:503,retryable:true};
    if(response.status>=500 || response.status===408 || [1,2,131000].includes(code??-1))
      return {accepted:false,code:"PROVIDER_UNAVAILABLE",status:503,retryable:true};
    return {accepted:false,code:"PROVIDER_REJECTED",status:502,retryable:false};
  }
}

/**
 * POST /v1/dispatch/atelier/credential-check
 * Read-only, constant-time proof of possession for AppFactory secret
 * reconciliation. Never makes a Meta request, even when dispatch is enabled.
 */
export function verifyAtelierIngestCredential(request:Request,env:AtelierMetaEnv):Response {
  if(request.method!=="POST")return reply(405,{error:"METHOD_NOT_ALLOWED"});
  if(!env.ATELIER_NOTIFY_INGEST_KEY || env.ATELIER_NOTIFY_INGEST_KEY.length<32)
    return reply(503,{error:"INGEST_NOT_CONFIGURED"});
  if(!equalSecret(env.ATELIER_NOTIFY_INGEST_KEY,request.headers.get("x-notify-auth")??""))
    return reply(401,{error:"UNAUTHORIZED"});
  return new Response(null,{status:204,headers:{
    "cache-control":"no-store, private","referrer-policy":"no-referrer"
  }});
}

/**
 * POST /v1/dispatch/atelier/whatsapp
 * One authenticated producer, strictly enumerated UTILITY templates, fail-closed
 * opt-in and provider configuration. No browser/CORS access.
 *
 * HTTP 202 only means Meta accepted the request, not delivery. Atelier must
 * persist the returned providerMessageId for its EXISTING signed webhook.
 */
export async function dispatchAtelierMeta(
  request:Request,env:AtelierMetaEnv,http:typeof fetch=fetch
):Promise<Response>{
  if(request.method!=="POST")return reply(405,{error:"METHOD_NOT_ALLOWED"});
  if(!env.ATELIER_NOTIFY_INGEST_KEY || env.ATELIER_NOTIFY_INGEST_KEY.length<32)
    return reply(503,{error:"INGEST_NOT_CONFIGURED"});
  if(!equalSecret(env.ATELIER_NOTIFY_INGEST_KEY,request.headers.get("x-notify-auth")??""))
    return reply(401,{error:"UNAUTHORIZED"});
  if(env.ATELIER_META_DISPATCH_ENABLED!=="true")
    return reply(503,{error:"CHANNEL_DISABLED"});
  // Channel activation requires a second explicit choice. A pilot cannot
  // accidentally turn into unrestricted delivery when the allowlist is empty.
  const mode=env.ATELIER_META_DISPATCH_MODE;
  if(mode!=="pilot" && mode!=="live")
    return reply(503,{error:"DISPATCH_MODE_NOT_CONFIGURED"});
  if(!validProviderConfig(env))return reply(503,{error:"META_PROVIDER_NOT_CONFIGURED"});
  if(!request.headers.get("content-type")?.toLowerCase().startsWith("application/json"))
    return reply(415,{error:"JSON_REQUIRED"});
  const length=request.headers.get("content-length");
  if(length && (!/^\d+$/.test(length)||Number(length)>MAX_INPUT_BYTES))
    return reply(413,{error:"BODY_TOO_LARGE"});
  let body:unknown;
  try{
    const raw=await request.text();
    if(encoder.encode(raw).length>MAX_INPUT_BYTES)return reply(413,{error:"BODY_TOO_LARGE"});
    body=JSON.parse(raw);
  }catch{return reply(400,{error:"INVALID_JSON"});}
  const data=parsePayload(body);
  if(!data)return reply(400,{error:"INVALID_EVENT"});
  if(mode==="pilot"){
    const raw=(env.ATELIER_META_PILOT_RECIPIENTS??"").split(",").map(x=>x.trim()).filter(Boolean);
    // Treat any malformed entry as an invalid pilot configuration; fail shut.
    if(raw.length===0 || raw.length>20 || raw.some(x=>!/^\+[1-9]\d{7,14}$/.test(x)))
      return reply(503,{error:"PILOT_RECIPIENTS_NOT_CONFIGURED"});
    if(!raw.includes(data.to))
      return reply(403,{error:"PILOT_RECIPIENT_NOT_ALLOWED"});
  }
  const approved=new Set((env.ATELIER_META_APPROVED_TEMPLATES??"").split(",").map(x=>x.trim()));
  if(!approved.has(data.templateName+":"+data.language))
    return reply(503,{error:"TEMPLATE_NOT_APPROVED"});
  const adapter=new MetaCloudApiAdapter(env,http);
  const sent=await adapter.sendTemplate(data);
  if(!sent.accepted)return reply(sent.status,{error:sent.code,retryable:sent.retryable});
  return reply(202,{
    accepted:true,status:"QUEUED",provider:"whatsapp-cloud",
    providerMessageId:sent.providerMessageId,
    accountRef:env.META_CLOUD_PHONE_NUMBER_ID
  });
}
