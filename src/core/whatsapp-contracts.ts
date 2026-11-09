import {plainObject} from './email-contracts.js';
import {groupIdPattern,type ProjectGroup} from './group-routing.js';

/**
 * Generic product-to-group WhatsApp message. The destination is never part of the
 * request: it comes only from the project's declarative server-side policy.
 */
export interface WhatsAppEventV1 {
  version:1; project:string; id:string; occurredAt:string; expiresAt:string;
  message:{text:string;link?:string;linkLabel?:string};
}
export interface WhatsAppProjectPolicy {
  groups:ProjectGroup[];
  allowedLinkOrigins:Set<string>;
}
export class WhatsAppPolicyError extends Error {}

const sessionPattern=/^[A-Za-z0-9_-]{1,48}$/;
// C0 controls other than LF, DEL and C1 controls are refused; text stays human-readable.
const controlPattern=/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/;

function origin(value:unknown):string{
  if(typeof value!=='string')throw new WhatsAppPolicyError('INVALID_ORIGIN');
  const url=new URL(value);
  if(url.protocol!=='https:'||url.pathname!=='/'||url.search||url.hash||url.username||url.password||url.port)
    throw new WhatsAppPolicyError('INVALID_ORIGIN');
  return url.origin;
}

/**
 * Parses one project's entry of WHATSAPP_PROJECTS_JSON. Returns null when the project
 * is absent or not explicitly enabled. Any malformed entry fails closed.
 */
export function parseWhatsAppPolicy(value:unknown,defaultSession:string|undefined):WhatsAppProjectPolicy|null{
  const policy=plainObject(value);
  if(!policy)throw new WhatsAppPolicyError('INVALID_POLICY');
  if(policy.enabled!==true)return null;
  if(!Array.isArray(policy.groups)||policy.groups.length>8)throw new WhatsAppPolicyError('INVALID_POLICY');
  const seen=new Set<string>(),groups:ProjectGroup[]=[];
  for(const entry of policy.groups){
    const item=typeof entry==='string'?{groupId:entry}:plainObject(entry);
    const session=item?.session??defaultSession,groupId=item?.groupId;
    if(typeof session!=='string'||!sessionPattern.test(session)||
      typeof groupId!=='string'||!groupIdPattern.test(groupId)||groupId.length>64)
      throw new WhatsAppPolicyError('INVALID_POLICY');
    const id=JSON.stringify([session,groupId]);
    if(!seen.has(id)){seen.add(id);groups.push({session,groupId});}
  }
  const origins=policy.allowedLinkOrigins??[];
  if(!Array.isArray(origins)||origins.length>8)throw new WhatsAppPolicyError('INVALID_POLICY');
  return {groups,allowedLinkOrigins:new Set(origins.map(origin))};
}

export function parseWhatsAppEvent(value:unknown,project:string,now:number,allowedLinkOrigins:Set<string>):WhatsAppEventV1{
  const d=plainObject(value),message=plainObject(d?.message);
  const allowed=new Set(['version','project','id','occurredAt','expiresAt','message']);
  if(!d||!message||Object.keys(d).some(k=>!allowed.has(k))||
    Object.keys(message).some(k=>!['text','link','linkLabel'].includes(k))||
    d.version!==1||d.project!==project||typeof d.id!=='string'||!/^[a-f0-9]{64}$/.test(d.id)||
    typeof d.occurredAt!=='string'||!Number.isFinite(Date.parse(d.occurredAt))||
    now-Date.parse(d.occurredAt)>300000||Date.parse(d.occurredAt)-now>60000||
    typeof d.expiresAt!=='string'||!Number.isFinite(Date.parse(d.expiresAt))||
    Date.parse(d.expiresAt)<=now||Date.parse(d.expiresAt)<=Date.parse(d.occurredAt)||
    Date.parse(d.expiresAt)-Date.parse(d.occurredAt)>86400000||
    typeof message.text!=='string'||!message.text.trim()||message.text.length>3000||controlPattern.test(message.text))
    throw Error('INVALID_WHATSAPP_EVENT');
  const result:WhatsAppEventV1['message']={text:message.text};
  if(message.link!==undefined){
    if(typeof message.link!=='string'||message.link.length>1024)throw Error('INVALID_WHATSAPP_EVENT');
    let url:URL;
    try{url=new URL(message.link);}catch{throw Error('INVALID_WHATSAPP_EVENT');}
    // Only links to the project's own declared origins: input cannot phish through a staff group.
    if(url.protocol!=='https:'||url.username||url.password||!allowedLinkOrigins.has(url.origin))
      throw Error('LINK_ORIGIN_DENIED');
    result.link=url.href;
  }
  if(message.linkLabel!==undefined){
    if(result.link===undefined||typeof message.linkLabel!=='string'||!message.linkLabel.trim()||
      message.linkLabel.length>80||/[\r\n]/.test(message.linkLabel)||controlPattern.test(message.linkLabel))
      throw Error('INVALID_WHATSAPP_EVENT');
    result.linkLabel=message.linkLabel;
  }
  return {version:1,project,id:d.id,occurredAt:d.occurredAt,expiresAt:d.expiresAt,message:result};
}

export function renderWhatsAppText(message:WhatsAppEventV1['message']):string{
  return message.link?message.text+'\n\n🔗 '+(message.linkLabel?message.linkLabel+'\n':'')+message.link:message.text;
}
