import {parseEmailEvent,plainObject,type EmailSender,type SmtpSettings} from './email-contracts.js';
import {claimEmail,finishEmail} from './email-receipts.js';
import type {NotifyDatabase} from './group-routing.js';

export interface EmailEnv {
  [key:string]:unknown;
  EMAIL_DISPATCH_ENABLED?:string; EMAIL_PROJECTS_JSON?:string;
  SMTP_HOST?:string; SMTP_PORT?:string; SMTP_USER?:string; SMTP_PASSWORD?:string; SMTP_PASSWORD_SECRET?:string;
  NOTIFY_DB?:NotifyDatabase;
}
const reply=(status:number,payload:object)=>new Response(JSON.stringify(payload),{
  status,headers:{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'}
});
function equalSecret(expected:string,received:string):boolean{
  const a=new TextEncoder().encode(expected),b=new TextEncoder().encode(received);let diff=a.length^b.length;
  for(let i=0;i<Math.max(a.length,b.length);i++)diff|=(a[i]??0)^(b[i]??0);return diff===0;
}
function mapping(value:string|undefined){return plainObject(JSON.parse(value||'{}'));}
async function limitedJson(request:Request):Promise<unknown>{
  const reader=request.body?.getReader();if(!reader)throw Error('INVALID_JSON');
  let size=0;const chunks:Uint8Array[]=[];
  try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;
    if(size>65536){await reader.cancel();throw Error('BODY_TOO_LARGE');}chunks.push(value);}}
  finally{reader.releaseLock();}
  const raw=new Uint8Array(size);let offset=0;for(const chunk of chunks){raw.set(chunk,offset);offset+=chunk.byteLength;}
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));
}
/** Reuses Notify's per-product server authentication and D1 storage boundaries. No group fanout. */
export async function dispatchEmail(request:Request,env:EmailEnv,sender:EmailSender,now=Date.now()):Promise<Response>{
  if(request.method!=='POST')return reply(405,{error:'METHOD_NOT_ALLOWED'});
  const project=new URL(request.url).pathname.match(/^\/v1\/dispatch\/([a-z][a-z0-9-]{1,48})\/email$/)?.[1];
  if(!project)return reply(404,{error:'NOT_FOUND'});
  let key:unknown,policy:Record<string,unknown>|null;
  try{const policies=mapping(env.EMAIL_PROJECTS_JSON);
    key=env['EMAIL_'+project.replaceAll('-','_').toUpperCase()+'_INGEST_KEY'];
    policy=policies&&Object.hasOwn(policies,project)?plainObject(policies[project]):null;
  }catch{return reply(503,{error:'EMAIL_NOT_CONFIGURED'});}
  if(typeof key!=='string'||key.length<32||key.length>256)return reply(503,{error:'INGEST_NOT_CONFIGURED'});
  const received=request.headers.get('x-notify-auth')||'';
  if(received.length>256||!equalSecret(key,received))return reply(401,{error:'UNAUTHORIZED'});
  if(env.EMAIL_DISPATCH_ENABLED!=='true'||policy?.enabled!==true)return reply(503,{error:'CHANNEL_DISABLED'});
  const from=policy.from;
  const fromAddress=typeof from==='string'?from.match(/^[^<>\r\n]{1,120} <([^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+)>$/)?.[1]:undefined;
  const host=env.SMTP_HOST?.trim()||'mail.spacemail.com',port=env.SMTP_PORT||'465',user=env.SMTP_USER?.trim()||'';
  // An operator can select an existing secret without copying its value or coupling the core to a provider.
  const passwordName=env.SMTP_PASSWORD_SECRET?.trim()||'SMTP_PASSWORD';
  const passwordValue=env[passwordName],password=typeof passwordValue==='string'?passwordValue:'';
  // SMTP AUTH usernames are provider identifiers (e.g. Resend's `resend`), not necessarily mailboxes.
  // Keep them bounded and reject whitespace/control characters before opening a connection.
  if(!/^[A-Z][A-Z0-9_]{1,63}$/.test(passwordName)||!fromAddress||typeof from!=='string'||!env.NOTIFY_DB||port!=='465'||host.length>253||
    !/^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?\.[a-zA-Z]{2,}$/.test(host)||
    !/^[\x21-\x7e]{1,256}$/.test(user)||!password||password.length>4096)
    return reply(503,{error:'EMAIL_NOT_CONFIGURED'});
  if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')||''))return reply(415,{error:'JSON_REQUIRED'});
  const length=request.headers.get('content-length');
  if(length&&(!/^\d+$/.test(length)||Number(length)>65536))return reply(413,{error:'BODY_TOO_LARGE'});
  let event;
  try{event=parseEmailEvent(await limitedJson(request),project,now);}
  catch(error){return reply(error instanceof Error&&error.message==='BODY_TOO_LARGE'?413:400,{error:'INVALID_EMAIL_EVENT'});}
  const db=env.NOTIFY_DB;let token:string;
  try{
    // A keyed fingerprint also protects low-entropy OTP content from offline guessing in a leaked ledger.
    const fingerprintKey=await crypto.subtle.importKey('raw',new TextEncoder().encode(key),{name:'HMAC',hash:'SHA-256'},false,['sign']);
    const digest=new Uint8Array(await crypto.subtle.sign('HMAC',fingerprintKey,new TextEncoder().encode(JSON.stringify({event,from}))));
    const hash=Array.from(digest,b=>b.toString(16).padStart(2,'0')).join('');
    const claim=await claimEmail(db,project,event.id,hash,Date.parse(event.expiresAt));
    if(claim.state==='accepted')return reply(202,{accepted:true,project,channel:'email',eventId:event.id});
    if(claim.state!=='claimed')return reply(503,{error:'EMAIL_DELIVERY_UNRESOLVED'});
    token=claim.token;
  }catch(error){return reply(error instanceof Error&&error.message==='EVENT_ID_REUSED'?409:503,{error:'EMAIL_RECEIPT_UNAVAILABLE'});}
  const settings:SmtpSettings={host,port:465,user,password};
  let result;
  try{result=await sender(settings,{from,recipient:event.recipient,...event.message,
    messageId:`<notify.${project}.${event.id}@${fromAddress.split('@')[1]}>`,date:event.occurredAt});}
  catch{result={accepted:false,safeToRetry:false} as const;}
  const state=result.accepted?'accepted':result.safeToRetry?'retry':'uncertain';
  try{await finishEmail(db,project,event.id,token,state);}
  catch{return reply(503,{error:'EMAIL_RECEIPT_UNAVAILABLE'});}
  return result.accepted?reply(202,{accepted:true,project,channel:'email',eventId:event.id})
    :reply(503,{error:result.safeToRetry?'SMTP_REJECTED':'EMAIL_DELIVERY_UNRESOLVED'});
}
