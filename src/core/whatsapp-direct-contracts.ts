/**
 * Individual (1:1) WhatsApp message to an E.164 number through WAHA.
 * Same envelope as the generic email route; the recipient is part of the request
 * because the product (not Notify) knows who must sign or be reminded.
 */
import {plainObject} from './email-contracts.js';

export interface WhatsAppDirectEventV1 {
  version:1; project:string; id:string; occurredAt:string; expiresAt:string;
  recipient:string; message:{text:string;link?:string;linkLabel?:string};
}
export interface WhatsAppDirectPolicy {
  limits:{perHour:number;perRecipientPerHour:number};
}
export class WhatsAppDirectPolicyError extends Error {}

/** E.164: a leading plus and 8 to 15 digits, first digit non-zero. */
export const E164_PATTERN=/^\+[1-9]\d{7,14}$/;
// C0 controls other than LF, DEL and C1 controls are refused; text stays human-readable.
const controlPattern=/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/;
export const MAX_TEXT_LENGTH=3000;

function bounded(value:unknown,max:number):number{
  if(!Number.isSafeInteger(value)||Number(value)<1||Number(value)>max)throw new WhatsAppDirectPolicyError('INVALID_POLICY');
  return Number(value);
}
/**
 * Parses one project's entry of WHATSAPP_DIRECT_PROJECTS_JSON. Returns null when the
 * project is not explicitly enabled. Limits are mandatory: a malformed entry fails closed.
 */
export function parseWhatsAppDirectPolicy(value:unknown):WhatsAppDirectPolicy|null{
  const policy=plainObject(value);
  if(!policy||Object.keys(policy).some(k=>!['enabled','limits'].includes(k)))throw new WhatsAppDirectPolicyError('INVALID_POLICY');
  if(policy.enabled!==true)return null;
  const limits=plainObject(policy.limits);
  if(!limits||Object.keys(limits).some(k=>!['perHour','perRecipientPerHour'].includes(k)))throw new WhatsAppDirectPolicyError('INVALID_POLICY');
  return {limits:{perHour:bounded(limits.perHour,100000),perRecipientPerHour:bounded(limits.perRecipientPerHour,1000)}};
}

export function parseWhatsAppDirectEvent(value:unknown,project:string,now:number):WhatsAppDirectEventV1{
  const d=plainObject(value),message=plainObject(d?.message);
  const allowed=new Set(['version','project','id','occurredAt','expiresAt','recipient','message']);
  if(!d||!message||Object.keys(d).some(k=>!allowed.has(k))||
    Object.keys(message).some(k=>!['text','link','linkLabel'].includes(k))||
    d.version!==1||d.project!==project||typeof d.id!=='string'||!/^[a-f0-9]{64}$/.test(d.id)||
    typeof d.occurredAt!=='string'||!Number.isFinite(Date.parse(d.occurredAt))||
    now-Date.parse(d.occurredAt)>300000||Date.parse(d.occurredAt)-now>60000||
    typeof d.expiresAt!=='string'||!Number.isFinite(Date.parse(d.expiresAt))||
    Date.parse(d.expiresAt)<=now||Date.parse(d.expiresAt)<=Date.parse(d.occurredAt)||
    Date.parse(d.expiresAt)-Date.parse(d.occurredAt)>86400000||
    typeof d.recipient!=='string'||!E164_PATTERN.test(d.recipient)||
    typeof message.text!=='string'||!message.text.trim()||message.text.length>MAX_TEXT_LENGTH||controlPattern.test(message.text))
    throw Error('INVALID_WHATSAPP_EVENT');
  const result:WhatsAppDirectEventV1['message']={text:message.text};
  if(message.link!==undefined){
    if(typeof message.link!=='string'||message.link.length>1024)throw Error('INVALID_WHATSAPP_EVENT');
    let url:URL;
    try{url=new URL(message.link);}catch{throw Error('INVALID_WHATSAPP_EVENT');}
    if(url.protocol!=='https:'||url.username||url.password)throw Error('INVALID_WHATSAPP_EVENT');
    result.link=url.href;
  }
  if(message.linkLabel!==undefined){
    if(result.link===undefined||typeof message.linkLabel!=='string'||!message.linkLabel.trim()||
      message.linkLabel.length>80||/[\r\n]/.test(message.linkLabel)||controlPattern.test(message.linkLabel))
      throw Error('INVALID_WHATSAPP_EVENT');
    result.linkLabel=message.linkLabel;
  }
  return {version:1,project,id:d.id,occurredAt:d.occurredAt,expiresAt:d.expiresAt,recipient:d.recipient,message:result};
}

/** `+237650000000` becomes `237650000000@c.us` (WAHA individual chat id). */
export function recipientChatId(recipient:string):string{
  if(!E164_PATTERN.test(recipient))throw Error('INVALID_RECIPIENT');
  return recipient.slice(1)+'@c.us';
}
/** Logs and errors keep only the last four digits of a number. */
export function maskRecipient(recipient:string):string{
  return '***'+recipient.replace(/\D/g,'').slice(-4);
}
export function renderWhatsAppDirectText(message:WhatsAppDirectEventV1['message']):string{
  return message.link?message.text+'\n\n🔗 '+(message.linkLabel?message.linkLabel+'\n':'')+message.link:message.text;
}
