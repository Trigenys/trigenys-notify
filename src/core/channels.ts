/**
 * Stateless adapters. NEVER claim a delivery or schedule retries here.
 * Xeption continues to use its existing notify-staff sender until an
 * explicitly coordinated channel-by-channel cutover.
 */
import type {SafeStaffMessage} from "./contracts.js";
export interface DeliveryResult {
  accepted:boolean;
  retryable:boolean;
  code:"ACCEPTED"|"PROVIDER_REJECTED"|"RATE_LIMITED"|"PROVIDER_UNAVAILABLE"|"NETWORK_ERROR"|"NETWORK_TIMEOUT"|"NETWORK_TRANSPORT";
  status?:number;
}
export interface ChannelAdapter {
  readonly id:"telegram"|"whatsapp_waha";
  send(message:SafeStaffMessage):Promise<DeliveryResult>;
}
function httpsOrigin(value:string):URL {
  const url=new URL(value);
  if (url.protocol!=="https:" || url.username || url.password ||
      url.search || url.hash || url.port || (url.pathname!=="/" && url.pathname!==""))
    throw new Error("CHANNEL_HTTPS_ORIGIN_REQUIRED");
  return url;
}
function result(status:number):DeliveryResult {
  if(status>=200 && status<300) return {accepted:true,retryable:false,code:"ACCEPTED",status};
  if(status===429)return {accepted:false,retryable:true,code:"RATE_LIMITED",status};
  if(status>=500)return {accepted:false,retryable:true,code:"PROVIDER_UNAVAILABLE",status};
  return {accepted:false,retryable:false,code:"PROVIDER_REJECTED",status};
}
function networkError():DeliveryResult{return {accepted:false,retryable:true,code:"NETWORK_ERROR"};}
export function renderStaffMessage(message:SafeStaffMessage):string {
  const text=message.title+"\n\n"+message.body+
    (message.actionUrl?"\n\n🔗 "+(message.actionLabel?message.actionLabel+'\n':'')+message.actionUrl:"");
  return text.slice(0,3500);
}
export interface WahaConfig {baseUrl:string;apiKey:string;session:string;groupChatId:string;}
/** Transport settings shared by group and individual WAHA deliveries. */
export interface WahaTextTarget {baseUrl:string;apiKey:string;session:string;chatId:string;}
export const WAHA_GROUP_CHAT_PATTERN=/^[0-9-]+@g\.us$/;
export const WAHA_INDIVIDUAL_CHAT_PATTERN=/^[1-9][0-9]{7,14}@c\.us$/;
/** Builds the sendText endpoint once; a chat id that matches neither pattern is refused. */
export function wahaTextEndpoint(target:WahaTextTarget):string {
  if(!target.apiKey || target.apiKey.length<8)throw new Error("WAHA_API_KEY_REQUIRED");
  if(!/^[A-Za-z0-9_-]{1,48}$/.test(target.session))throw new Error("WAHA_SESSION_INVALID");
  if(!WAHA_GROUP_CHAT_PATTERN.test(target.chatId) && !WAHA_INDIVIDUAL_CHAT_PATTERN.test(target.chatId))
    throw new Error("WAHA_CHAT_INVALID");
  return new URL("/api/sendText",httpsOrigin(target.baseUrl)).href;
}
/** Stateless WAHA text send with the shared result mapping; never logs ids, keys or text. */
export async function sendWahaText(target:WahaTextTarget,text:string,http:typeof fetch=fetch,endpoint=wahaTextEndpoint(target)):Promise<DeliveryResult> {
  const startedAt=Date.now();
  try {
    // Cloudflare workerd requires the native fetch receiver to be undefined/global.
    // Calling it as this.http(...) causes an immediate TypeError: Illegal invocation.
    const response=await http(endpoint,{
      method:"POST",
      headers:{"content-type":"application/json","accept":"application/json","X-Api-Key":target.apiKey},
      body:JSON.stringify({session:target.session,chatId:target.chatId,text,linkPreview:false}),
      signal:AbortSignal.timeout(25000)
    });
    return result(response.status);
  } catch(error) {
    // Avoid logging raw error messages, request bodies, URLs, chat IDs
    // or provider keys. Keep only a low-cardinality failure category.
    const name=error instanceof Error?error.name:"";
    const code=name==="TimeoutError"||name==="AbortError"
      ?"NETWORK_TIMEOUT":name==="TypeError"?"NETWORK_TRANSPORT":"NETWORK_ERROR";
    console.warn("notify.waha_transport_failed",{
      category:code,elapsedMs:Date.now()-startedAt
    });
    return {accepted:false,retryable:true,code};
  }
}
export class WahaAdapter implements ChannelAdapter {
  readonly id="whatsapp_waha" as const;
  private readonly endpoint:string;
  constructor(private readonly config:WahaConfig,private readonly http:typeof fetch=fetch) {
    if(!WAHA_GROUP_CHAT_PATTERN.test(config.groupChatId))throw new Error("WAHA_GROUP_REQUIRED");
    this.endpoint=wahaTextEndpoint({...config,chatId:config.groupChatId});
  }
  async send(message:SafeStaffMessage):Promise<DeliveryResult> {
    return sendWahaText({...this.config,chatId:this.config.groupChatId},renderStaffMessage(message),this.http,this.endpoint);
  }
}
export interface TelegramConfig {token:string;chatId:string;}
export class TelegramAdapter implements ChannelAdapter {
  readonly id="telegram" as const;
  constructor(private readonly config:TelegramConfig,private readonly http:typeof fetch=fetch) {
    if(!/^\d{4,}:[a-zA-Z0-9_-]{15,}$/.test(config.token))throw new Error("TELEGRAM_TOKEN_INVALID");
    if(!/^-?\d{5,20}$/.test(config.chatId))throw new Error("TELEGRAM_CHAT_INVALID");
  }
  async send(message:SafeStaffMessage):Promise<DeliveryResult> {
    try {
      // Do not call a native fetch stored on an object as a method in workerd.
      const http=this.http;
      const response=await http(
        "https://api.telegram.org/bot"+this.config.token+"/sendMessage",{
          method:"POST",headers:{"content-type":"application/json"},
          body:JSON.stringify({
            chat_id:this.config.chatId,text:renderStaffMessage(message),disable_web_page_preview:true
          }),
          signal:AbortSignal.timeout(10000)
        });
      return result(response.status);
    } catch {return networkError();}
  }
}
/** Implement against a persistent, atomic outbox; never an in-memory queue. */
export interface ClaimedDelivery {
  project:string;
  eventId:string;
  channel:ChannelAdapter["id"];
  attempt:number;
}
export interface DeliveryOutbox {
  claimNext(channel:ChannelAdapter["id"],max:number):Promise<ClaimedDelivery[]>;
  markAccepted(item:ClaimedDelivery):Promise<void>;
  markRejected(item:ClaimedDelivery,result:DeliveryResult):Promise<void>;
}

