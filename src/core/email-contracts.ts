/** Transactional email is separate from staff group events: never broadcast auth links. */
export interface EmailEventV1 {
  version:1; project:string; id:string; occurredAt:string; expiresAt:string;
  recipient:string; message:{subject:string;html:string;text:string};
}
export interface SmtpSettings {host:string;port:465;user:string;password:string;}
export interface SmtpMessage {
  from:string;recipient:string;messageId:string;date:string;
  subject:string;html:string;text:string;
}
export type SmtpResult = {accepted:true}|{accepted:false;safeToRetry:boolean};
export type EmailSender=(settings:SmtpSettings,message:SmtpMessage)=>Promise<SmtpResult>;
export function plainObject(value:unknown):Record<string,unknown>|null{
  return value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;
}
export function parseEmailEvent(value:unknown,project:string,now:number):EmailEventV1{
  const d=plainObject(value),message=plainObject(d?.message);
  const allowed=new Set(['version','project','id','occurredAt','expiresAt','recipient','message']);
  if(!d||!message||Object.keys(d).some(k=>!allowed.has(k))||
    Object.keys(message).some(k=>!['subject','html','text'].includes(k))||
    d.version!==1||d.project!==project||typeof d.id!=='string'||!/^[a-f0-9]{64}$/.test(d.id)||
    typeof d.occurredAt!=='string'||!Number.isFinite(Date.parse(d.occurredAt))||
    now-Date.parse(d.occurredAt)>300000||Date.parse(d.occurredAt)-now>60000||
    typeof d.expiresAt!=='string'||!Number.isFinite(Date.parse(d.expiresAt))||
    Date.parse(d.expiresAt)<=now||Date.parse(d.expiresAt)<=Date.parse(d.occurredAt)||
    Date.parse(d.expiresAt)-Date.parse(d.occurredAt)>86400000||
    typeof d.recipient!=='string'||d.recipient.length>254||!/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(d.recipient)||
    typeof message.subject!=='string'||!message.subject.trim()||message.subject.length>256||/[\r\n]/.test(message.subject)||
    typeof message.html!=='string'||!message.html||message.html.length>49152||
    typeof message.text!=='string'||!message.text||message.text.length>32768)throw Error('INVALID_EMAIL_EVENT');
  return {version:1,project,id:d.id,occurredAt:d.occurredAt,expiresAt:d.expiresAt,recipient:d.recipient,
    message:{subject:message.subject,html:message.html,text:message.text}};
}
