/**
 * Stateless adapters. NEVER claim a delivery or schedule retries here.
 * Xeption continues to use its existing notify-staff sender until an
 * explicitly coordinated channel-by-channel cutover.
 */
import type {SafeStaffMessage} from "./contracts.js";
export interface DeliveryResult {
  accepted:boolean;
  retryable:boolean;
  code:"ACCEPTED"|"PROVIDER_REJECTED"|"RATE_LIMITED"|"PROVIDER_UNAVAILABLE"|"NETWORK_ERROR";
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
function render(message:SafeStaffMessage):string {
  const text=message.title+"\n\n"+message.body+
    (message.actionUrl?"\n\n🔗 "+message.actionUrl:"");
  return text.slice(0,3500);
}
export interface WahaConfig {baseUrl:string;apiKey:string;session:string;groupChatId:string;}
export class WahaAdapter implements ChannelAdapter {
  readonly id="whatsapp_waha" as const;
  private readonly endpoint:string;
  constructor(private readonly config:WahaConfig,private readonly http:typeof fetch=fetch) {
    if(!config.apiKey || config.apiKey.length<8)throw new Error("WAHA_API_KEY_REQUIRED");
    if(!/^[A-Za-z0-9_-]{1,48}$/.test(config.session))throw new Error("WAHA_SESSION_INVALID");
    if(!/^[0-9-]+@g\.us$/.test(config.groupChatId))throw new Error("WAHA_GROUP_REQUIRED");
    this.endpoint=new URL("/api/sendText",httpsOrigin(config.baseUrl)).href;
  }
  async send(message:SafeStaffMessage):Promise<DeliveryResult> {
    try {
      const response=await this.http(this.endpoint,{
        method:"POST",
        headers:{"content-type":"application/json","accept":"application/json","X-Api-Key":this.config.apiKey},
        body:JSON.stringify({
          session:this.config.session,chatId:this.config.groupChatId,
          text:render(message),linkPreview:false
        }),
        signal:AbortSignal.timeout(10000)
      });
      return result(response.status);
    } catch {return networkError();}
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
      const response=await this.http(
        "https://api.telegram.org/bot"+this.config.token+"/sendMessage",{
          method:"POST",headers:{"content-type":"application/json"},
          body:JSON.stringify({
            chat_id:this.config.chatId,text:render(message),disable_web_page_preview:true
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
