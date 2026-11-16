/**
 * Trigenys Notify: staff gestures from approved WhatsApp groups, relayed to the producer project.
 *
 * A reaction or a quoted reply to an alert Notify delivered, or a link code typed in an approved
 * group, is signed and relayed to the project's own endpoint (configured, never hard-coded).
 * The project decides; Notify only posts its answer back as a quoted follow-up line.
 *
 * Minimal data: the author's number never leaves Notify. Only a keyed HMAC fingerprint of it is
 * relayed, so the project can match its own staff records. The relayed id is the message key
 * (no chat id, no phone number), free text is not relayed, and logs carry only project, gesture
 * and outcome codes.
 */
import {httpsOrigin,sendWahaText,type WahaTextTarget} from './channels.js';
import {groupIdPattern,type NotifyDatabase} from './group-routing.js';
import {wahaMessageKeyId} from './waha-message-id.js';
import {ACTION_RECORDED_TITLE} from './contracts.js';

export interface StaffActionEnv {
  [key:string]:unknown;
  WHATSAPP_ACTIONS_ENABLED?:string;
  /** JSON {project:{url,signingKeySecret?,replyPattern?,linkPattern?,timeZone?}} */
  WHATSAPP_ACTION_RELAYS_JSON?:string;
  WAHA_BASE_URL?:string;
  WAHA_API_KEY?:string;
  NOTIFY_DB?:NotifyDatabase;
}
export type Gesture='reaction'|'reply'|'link';
export interface StaffGesture {
  session:string;groupId:string;
  /** Message key of the gesture itself: stable across webhook retries, no phone number. */
  id:string;
  /**
   * Normalized author jid: `<digits>@c.us` when the payload carries the number, else `<id>@lid`
   * (resolved to a number through WAHA before relaying). Never relayed or logged.
   */
  actor:string;
  kind:'reaction'|'text';
  value:string;
  /** Message key of the alert (or follow-up) the gesture refers to. */
  quotedKey?:string;
}
export interface RelayConfig {
  project:string;url:string;signingKeySecret:string;
  replyPattern:RegExp;linkPattern:RegExp;timeZone:string;
}
export interface RelayBody {
  version:1;id:string;eventId:string;groupKey:string;
  actor:{fingerprint:string};gesture:Gesture;value:string;
}
export interface RelayAnswer {
  ok?:boolean;changed?:boolean;outcome?:string;action?:string;
  reason?:string;attempt?:number;actor?:string;at?:string;
  /** Set when the project linked the author's number to a staff account on this gesture. */
  linked?:{actor?:string;role?:string;store?:string};
  /** Set with `not_linked`: why the number could not be linked automatically. */
  link?:{reason?:string};
}

export const STAFF_ACTION_EVENTS=new Set(['message.reaction','message']);
const MIN_KEY_LENGTH=32;
const MAX_RELAY_BYTES=4096;
const MAX_VALUE_CHARS=64;
const MAX_ID_CHARS=128;
const MAX_ANSWER_BYTES=4096;
const RELAY_TIMEOUT_MS=10000;
/** Follow-up ids are kept long enough for a late "reply 1 to 5". */
const FOLLOW_UP_TTL_MS=7*24*3600000;
const REMINDER_TTL_MS=3*24*3600000;
const LID_LOOKUP_TIMEOUT_MS=5000;
/** Prefix of the fingerprinted value, shared with the consumer (versioned: changing it unlinks everyone). */
const ACTOR_FINGERPRINT_PREFIX='wa-actor:v1:';
/** E.164 without `+`. */
const phonePattern=/^[1-9]\d{7,14}$/;
const MAX_ACTOR_CHARS=40;
const MAX_REASON_CHARS=80;
const MAX_ATTEMPT=99;
const DEFAULT_REPLY_PATTERN='^[1-9]$';
const DEFAULT_LINK_PATTERN='^XL-[A-Z2-9]{4}-[A-Z2-9]{4}$';
const DEFAULT_TIME_ZONE='Africa/Douala';
const projectPattern=/^[a-z][a-z0-9-]{1,48}$/;
const sessionPattern=/^[-_a-zA-Z0-9]{1,48}$/;
/** Project answers that warrant a follow-up line; everything else (duplicate, ignored...) is silent. */
const FOLLOW_UP_OUTCOMES=new Set(['delivered','cash_delivered','unreachable','cancelled','reason_required',
  'needs_payment','closed','not_linked','cancel_forbidden','linked','invalid_code']);

const reply=(status:number,payload:object)=>new Response(JSON.stringify(payload),{
  status,headers:{'content-type':'application/json','cache-control':'no-store'}
});
const record=(v:unknown):Record<string,unknown>|undefined=>
  v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:undefined;
const hex=(bytes:ArrayBuffer)=>Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
async function hmac(hash:'SHA-256'|'SHA-512',key:string,value:string):Promise<string>{
  const k=await crypto.subtle.importKey('raw',new TextEncoder().encode(key),{name:'HMAC',hash},false,['sign']);
  return hex(await crypto.subtle.sign('HMAC',k,new TextEncoder().encode(value)));
}
/** Shared contract with the consumer: hex HMAC-SHA512(key, `${timestamp}.${raw}`). */
export const signRelay=(key:string,timestamp:string,raw:string)=>hmac('SHA-512',key.trim(),`${timestamp}.${raw}`);
/** Shared contract: hex HMAC-SHA256(signing key, `wa-actor:v1:<E.164 without +>`). */
export const actorFingerprint=(key:string,phone:string)=>
  hmac('SHA-256',key.trim(),ACTOR_FINGERPRINT_PREFIX+phone);
/** Opaque group identifier: the project can tell groups apart without learning their ids. */
export const groupKey=(key:string,session:string,groupId:string)=>
  hmac('SHA-256',key.trim(),'group:'+session+':'+groupId);

/** `<digits>[:device]@c.us|s.whatsapp.net` or `<id>[:device]@lid`; anything else is no author. */
export function normalizeActor(value:unknown):string|undefined{
  if(typeof value!=='string')return undefined;
  const phone=/^(\d{6,20})(?::\d{1,4})?@(?:c\.us|s\.whatsapp\.net)$/.exec(value);
  if(phone)return phone[1]+'@c.us';
  const lid=/^(\d{6,30})(?::\d{1,4})?@lid$/.exec(value);
  return lid?lid[1]+'@lid':undefined;
}

/** Reads the declarative relay configuration; an invalid entry disables only that project. */
export function relayConfigs(env:StaffActionEnv):RelayConfig[]{
  if(env.WHATSAPP_ACTIONS_ENABLED!=='true'||!env.WHATSAPP_ACTION_RELAYS_JSON)return [];
  let raw:unknown;
  try{raw=JSON.parse(env.WHATSAPP_ACTION_RELAYS_JSON);}catch{console.warn('notify.staff_action_config_invalid');return [];}
  const configs:RelayConfig[]=[];
  for(const [project,value] of Object.entries(record(raw)??{})){
    const v=record(value);
    try{
      if(!projectPattern.test(project)||!v||typeof v.url!=='string')throw Error();
      const url=new URL(v.url);
      if(url.protocol!=='https:'||url.username||url.password)throw Error();
      const prefix=project.replaceAll('-','_').toUpperCase();
      const name=(field:unknown,fallback:string)=>{
        const n=field===undefined?fallback:field;
        if(typeof n!=='string'||!/^[A-Z][A-Z0-9_]{2,63}$/.test(n))throw Error();
        return n;
      };
      const timeZone=typeof v.timeZone==='string'?v.timeZone:DEFAULT_TIME_ZONE;
      new Intl.DateTimeFormat('fr-FR',{timeZone}); // throws on an unknown zone
      configs.push({project,url:url.href,
        signingKeySecret:name(v.signingKeySecret,prefix+'_NOTIFY_ACTION_KEY'),
        replyPattern:new RegExp(typeof v.replyPattern==='string'?v.replyPattern:DEFAULT_REPLY_PATTERN),
        linkPattern:new RegExp(typeof v.linkPattern==='string'?v.linkPattern:DEFAULT_LINK_PATTERN,'i'),
        timeZone});
    }catch{console.warn('notify.staff_action_config_invalid',{project:projectPattern.test(project)?project:'invalid'});}
  }
  return configs;
}

/** Quoted message key in a WAHA `message` payload (documented field, then NOWEB raw context). */
function quotedKey(payload:Record<string,unknown>):string|undefined{
  const replyTo=record(payload.replyTo);
  const fromReply=wahaMessageKeyId(replyTo?.id)??wahaMessageKeyId(replyTo);
  if(fromReply)return fromReply;
  const message=record(record(payload._data)?.message);
  for(const kind of ['extendedTextMessage','conversation','imageMessage']){
    const context=record(record(message?.[kind])?.contextInfo);
    const key=wahaMessageKeyId(context?.stanzaId);
    if(key)return key;
  }
  return undefined;
}

/** Extracts a staff gesture from a signed WAHA envelope; anything else is null (ignored). */
export function parseStaffGesture(data:unknown):StaffGesture|null{
  const d=record(data),payload=record(d?.payload);
  if(!d||!payload||typeof d.event!=='string'||!STAFF_ACTION_EVENTS.has(d.event))return null;
  if(typeof d.session!=='string'||!sessionPattern.test(d.session))return null;
  if(payload.fromMe===true)return null; // Notify's own messages never trigger an action.
  const groupId=payload.from;
  if(typeof groupId!=='string'||!groupIdPattern.test(groupId))return null;
  // Prefer a number: NOWEB may expose it next to a LID (participantPn / participantAlt).
  const rawKey=record(record(payload._data)?.key);
  const candidates=[payload.participant,rawKey?.participant,rawKey?.participantPn,rawKey?.participantAlt]
    .map(normalizeActor).filter((v):v is string=>!!v);
  const actor=candidates.find(v=>v.endsWith('@c.us'))??candidates[0];
  const envelopeId=typeof d.id==='string'&&d.id.length<=MAX_ID_CHARS&&/^[A-Za-z0-9_-]+$/.test(d.id)?d.id:undefined;
  const id=wahaMessageKeyId(payload.id)??envelopeId;
  if(!actor||!id)return null;
  if(d.event==='message.reaction'){
    const reaction=record(payload.reaction);
    const value=typeof reaction?.text==='string'?reaction.text:'';
    const key=wahaMessageKeyId(reaction?.messageId);
    // An empty reaction is a removal: never an action.
    if(!value||value.length>MAX_VALUE_CHARS||!key)return null;
    return {session:d.session,groupId,id,actor,kind:'reaction',value,quotedKey:key};
  }
  const body=typeof payload.body==='string'?payload.body.trim():'';
  if(!body||body.length>MAX_VALUE_CHARS)return null;
  const key=quotedKey(payload);
  return {session:d.session,groupId,id,actor,kind:'text',value:body,...(key?{quotedKey:key}:{})};
}

/**
 * Author's number (E.164 without `+`). A LID is resolved through WAHA's LID API; any failure
 * (unknown LID, WAHA unavailable) is undefined: a fingerprint of anything else would never match.
 */
export async function resolveActorPhone(env:StaffActionEnv,session:string,actor:string,
  fetchImpl:typeof fetch):Promise<string|undefined>{
  actor=normalizeActor(actor)??'';
  const direct=/^(\d+)@c\.us$/.exec(actor);
  if(direct)return phonePattern.test(direct[1])?direct[1]:undefined;
  if(!actor.endsWith('@lid')||!env.WAHA_BASE_URL||!env.WAHA_API_KEY||!sessionPattern.test(session))return undefined;
  try{
    const url=new URL(`/api/${session}/lids/${encodeURIComponent(actor)}`,httpsOrigin(env.WAHA_BASE_URL));
    const response=await fetchImpl(url.href,{headers:{accept:'application/json','X-Api-Key':env.WAHA_API_KEY},
      signal:AbortSignal.timeout(LID_LOOKUP_TIMEOUT_MS)});
    if(!response.ok)return undefined;
    const pn=normalizeActor(record(await response.json())?.pn);
    const digits=pn?.endsWith('@c.us')?pn.slice(0,-'@c.us'.length):undefined;
    return digits&&phonePattern.test(digits)?digits:undefined;
  }catch{return undefined;}
}

/** Projects whose approved, available route includes this group. */
async function approvedProjects(db:NotifyDatabase,session:string,groupId:string):Promise<Set<string>>{
  const rows=await db.prepare(`SELECT DISTINCT r.project AS project FROM notify_whatsapp_routes r
    JOIN notify_whatsapp_groups g ON g.session=r.session AND g.group_id=r.group_id
    WHERE r.session=?1 AND r.group_id=?2 AND r.enabled=1 AND g.state='available'`)
    .bind(session,groupId).all<{project:string}>();
  return new Set(rows.results.map(r=>r.project));
}

/** Alert (receipt) or follow-up line the gesture quotes, in this very group. */
export async function correlate(db:NotifyDatabase,session:string,groupId:string,key:string)
  :Promise<{project:string;eventId:string}|null>{
  const receipt=await db.prepare(`SELECT project,event_id AS eventId FROM notify_whatsapp_receipts
    WHERE session=?1 AND provider_message_id=?2 AND group_id=?3 AND state='accepted' LIMIT 1`)
    .bind(session,key,groupId).first<{project:string;eventId:string}>();
  if(receipt)return receipt;
  try{
    return await db.prepare(`SELECT project,event_id AS eventId FROM notify_whatsapp_action_messages
      WHERE session=?1 AND provider_message_id=?2 AND group_id=?3 AND expires_at_ms>?4 LIMIT 1`)
      .bind(session,key,groupId,Date.now()).first<{project:string;eventId:string}>();
  }catch{return null;} // Migration 0007 not applied yet: follow-ups are simply not correlated.
}

type RelayResult={kind:'answer';answer:RelayAnswer}|{kind:'retry';code:string}|{kind:'stop';code:string};
/** POST the signed body; only 5xx other than 503, 429 and transport errors are worth a retry. */
export async function postRelay(config:RelayConfig,key:string,body:RelayBody,
  fetchImpl:typeof fetch,now=Date.now()):Promise<RelayResult>{
  const raw=JSON.stringify(body);
  if(new TextEncoder().encode(raw).length>MAX_RELAY_BYTES)return {kind:'stop',code:'BODY_TOO_LARGE'};
  const timestamp=String(now);
  let response:Response;
  try{
    response=await fetchImpl(config.url,{method:'POST',body:raw,signal:AbortSignal.timeout(RELAY_TIMEOUT_MS),
      headers:{'content-type':'application/json','x-notify-timestamp':timestamp,
        'x-notify-signature':await signRelay(key,timestamp,raw)}});
  }catch{return {kind:'retry',code:'NETWORK_ERROR'};}
  const status=response.status;
  if(status===200){
    try{
      const text=await response.text();
      const answer=text.length<=MAX_ANSWER_BYTES?record(JSON.parse(text)):undefined;
      return answer?{kind:'answer',answer:answer as RelayAnswer}:{kind:'stop',code:'INVALID_ANSWER'};
    }catch{return {kind:'stop',code:'INVALID_ANSWER'};}
  }
  // 503 means "not configured / channel disabled" on the consumer: retrying cannot help.
  if(status===429||(status>=500&&status!==503))return {kind:'retry',code:'HTTP_'+status};
  return {kind:'stop',code:'HTTP_'+status};
}

const clean=(value:unknown,max:number)=>typeof value==='string'
  ?value.replace(/[\u0000-\u001f\u007f*_~`]/g,' ').replace(/\s+/g,' ').trim().slice(0,max):'';
function clock(at:unknown,timeZone:string):string{
  if(typeof at!=='string')return '';
  const date=new Date(at);
  if(Number.isNaN(date.getTime()))return '';
  return new Intl.DateTimeFormat('fr-FR',{timeZone,hour:'2-digit',minute:'2-digit',hour12:false}).format(date);
}
const NOT_LINKED_DEFAULT='Numéro non lié à un compte staff : envoyez dans ce groupe le code de liaison affiché dans votre espace staff.';
const ALREADY_LINKED="Ce compte est déjà lié à un autre numéro. Pour changer de téléphone, utilisez le code de l'ERP (Équipe → Lier mon WhatsApp).";
/** Why automatic linking failed, as the project reports it; an unknown reason uses the default line. */
const NOT_LINKED_LINES:Record<string,string>={
  phone_not_found:"Votre numéro n'est pas encore dans l'ERP. Demandez à la direction de l'ajouter à votre fiche (écran Équipe), puis refaites le geste.",
  phone_ambiguous:"Ce numéro figure sur plusieurs fiches de l'ERP. La direction doit corriger les fiches avant toute liaison.",
  use_erp_code:"Les comptes direction se lient avec le code de l'ERP : Équipe → Lier mon WhatsApp, puis envoyez le code ici.",
  no_account:"Votre fiche n'a pas encore de compte de connexion. La direction doit le créer depuis l'écran Équipe.",
  staff_already_linked:ALREADY_LINKED,
  fingerprint_already_linked:ALREADY_LINKED
};
const ROLE_LABELS:Record<string,string>={vendeur:'Vendeur',editor:'Vendeur',responsable:'Responsable',
  manager:'Manager',manager_vente:'Manager'};
const MAX_STORE_CHARS=40;

/**
 * Notice posted once when the project linked the author's number on this gesture, before the
 * gesture's own follow-up. First name, role label and store only; null without a first name.
 */
export function renderLinkedNotice(answer:RelayAnswer):string|null{
  const linked=record(answer.linked);
  const actor=clean(linked?.actor,MAX_ACTOR_CHARS);
  if(!actor)return null;
  const role=typeof linked?.role==='string'?ROLE_LABELS[linked.role]??'':'';
  const details=[role,clean(linked?.store,MAX_STORE_CHARS)].filter(Boolean).join(' · ');
  return ACTION_RECORDED_TITLE+'\n'+`Numéro reconnu : *${actor}*${details?` (${details})`:''}. `+
    'Ses réactions aux alertes commande sont désormais enregistrées à son nom.\n'+
    "Ce n'est pas vous ? Signalez-le à la direction, qui corrigera le numéro dans l'ERP (écran Équipe).";
}

/**
 * One follow-up line built only from the project's answer: action, reason, attempt, first name,
 * time. No emoji and no client data. Null means silence (duplicate, ignored, unknown).
 */
export function renderFollowUp(answer:RelayAnswer,timeZone=DEFAULT_TIME_ZONE):string|null{
  const outcome=typeof answer.outcome==='string'?answer.outcome:'';
  if(!FOLLOW_UP_OUTCOMES.has(outcome))return null;
  const actor=clean(answer.actor,MAX_ACTOR_CHARS),time=clock(answer.at,timeZone);
  const by=(actor?' par '+actor:'')+(time?' à '+time:'');
  const attempt=Number.isInteger(answer.attempt)&&answer.attempt!>0&&answer.attempt!<=MAX_ATTEMPT
    ?', tentative '+answer.attempt:'';
  const reason=clean(answer.reason,MAX_REASON_CHARS);
  const lines:Record<string,string>={
    delivered:`Livraison enregistrée${by}.`,
    cash_delivered:`Livraison et encaissement enregistrés${by}.`,
    unreachable:`Client injoignable${attempt}, noté${by}.`,
    cancelled:`Annulation enregistrée${by}.`+(reason?` Motif : ${reason}.`:''),
    reason_required:"Motif d'annulation requis : répondez à ce message par un chiffre de 1 à 5.",
    needs_payment:"Action refusée : le paiement n'est pas encore confirmé.",
    closed:'Commande déjà clôturée : aucune modification.',
    not_linked:NOT_LINKED_LINES[typeof answer.link?.reason==='string'?answer.link.reason:'']??NOT_LINKED_DEFAULT,
    cancel_forbidden:'Annulation réservée à la direction.',
    linked:`Numéro lié au compte${actor?' de '+actor:''}.`,
    invalid_code:'Code de liaison invalide ou expiré.'
  };
  return ACTION_RECORDED_TITLE+'\n'+lines[outcome];
}

/**
 * Reserves this hour's reminder slot for the author; false when already used, or when migration
 * 0007 is missing. The `day` column holds the local hour bucket (`YYYY-MM-DD HH`).
 */
async function reserveReminder(db:NotifyDatabase,project:string,fingerprint:string,timeZone:string,now:number){
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',
    day:'2-digit',hour:'2-digit',hourCycle:'h23'}).formatToParts(now).map(p=>[p.type,p.value]));
  const day=`${parts.year}-${parts.month}-${parts.day} ${parts.hour}`;
  try{
    const row=await db.prepare(`INSERT INTO notify_whatsapp_action_reminders(project,actor_fingerprint,day,expires_at_ms)
      VALUES(?1,?2,?3,?4) ON CONFLICT(project,actor_fingerprint,day) DO NOTHING RETURNING day`)
      .bind(project,fingerprint,day,now+REMINDER_TTL_MS).first<{day:string}>();
    return row!==null;
  }catch{return false;}
}

export async function cleanupStaffActions(db:NotifyDatabase,now=Date.now()):Promise<void>{
  for(const table of ['notify_whatsapp_action_messages','notify_whatsapp_action_reminders']){
    await db.prepare(`DELETE FROM ${table} WHERE rowid IN
      (SELECT rowid FROM ${table} WHERE expires_at_ms<?1 ORDER BY expires_at_ms LIMIT 200)`).bind(now).run();
  }
}

/** Posts the follow-up as a quoted reply and remembers its key for later replies to it. */
async function postFollowUp(env:StaffActionEnv,db:NotifyDatabase,gesture:StaffGesture,text:string,
  quoted:{key:string;project:string;eventId:string}|undefined,fetchImpl:typeof fetch,now:number){
  if(!env.WAHA_BASE_URL||!env.WAHA_API_KEY)return;
  const target:WahaTextTarget={baseUrl:env.WAHA_BASE_URL,apiKey:env.WAHA_API_KEY,
    session:gesture.session,chatId:gesture.groupId};
  try{
    // Alerts and follow-ups are Notify's own messages in this group: fromMe=true.
    const result=await sendWahaText(target,text,fetchImpl,undefined,
      quoted?`true_${gesture.groupId}_${quoted.key}`:undefined);
    if(!result.accepted||!quoted||!result.providerMessageId)return;
    await db.prepare(`INSERT INTO notify_whatsapp_action_messages
      (session,provider_message_id,group_id,project,event_id,expires_at_ms) VALUES(?1,?2,?3,?4,?5,?6)
      ON CONFLICT(session,provider_message_id) DO NOTHING`)
      .bind(gesture.session,result.providerMessageId,gesture.groupId,quoted.project,quoted.eventId,now+FOLLOW_UP_TTL_MS).run();
  }catch{console.warn('notify.staff_action_follow_up_unavailable');}
}

/**
 * Handles one authenticated WAHA message/reaction event. Always 200 (ignored or relayed),
 * except 503 when the project asked for a retry, so that WAHA redelivers the same event.
 */
export async function handleStaffAction(data:unknown,env:StaffActionEnv,
  fetchImpl:typeof fetch=fetch,now=Date.now()):Promise<Response>{
  const configs=relayConfigs(env);
  const db=env.NOTIFY_DB;
  const gesture=configs.length&&db?parseStaffGesture(data):null;
  if(!gesture||!db)return reply(200,{accepted:true,relayed:0});
  const approved=await approvedProjects(db,gesture.session,gesture.groupId);
  const targets:{config:RelayConfig;gesture:Gesture;eventId:string;quoted?:{key:string;project:string;eventId:string}}[]=[];
  for(const config of configs){
    if(!approved.has(config.project))continue; // Unapproved group: silently ignored.
    if(gesture.kind==='text'&&config.linkPattern.test(gesture.value)){
      targets.push({config,gesture:'link',eventId:''});
      continue;
    }
    if(!gesture.quotedKey)continue;
    if(gesture.kind==='text'&&!config.replyPattern.test(gesture.value))continue; // Free text never leaves Notify.
    const match=await correlate(db,gesture.session,gesture.groupId,gesture.quotedKey);
    if(!match||match.project!==config.project)continue;
    targets.push({config,gesture:gesture.kind==='reaction'?'reaction':'reply',eventId:match.eventId,
      quoted:{key:gesture.quotedKey,...match}});
  }
  let retry=false;
  // Resolved once, only when something is to be relayed (a LID costs one WAHA lookup).
  const phone=targets.length?await resolveActorPhone(env,gesture.session,gesture.actor,fetchImpl):undefined;
  for(const target of targets){
    const {config}=target;
    const signingKey=String(env[config.signingKeySecret]??'').trim();
    if(signingKey.length<MIN_KEY_LENGTH){
      console.warn('notify.staff_action',{project:config.project,gesture:target.gesture,outcome:'not_configured'});
      continue;
    }
    if(!phone){
      console.warn('notify.staff_action',{project:config.project,gesture:target.gesture,outcome:'lid_unresolved'});
      continue;
    }
    const fingerprint=await actorFingerprint(signingKey,phone);
    const body:RelayBody={version:1,id:gesture.id,eventId:target.eventId,
      groupKey:await groupKey(signingKey,gesture.session,gesture.groupId),
      actor:{fingerprint},gesture:target.gesture,
      value:target.gesture==='link'?gesture.value.toUpperCase():gesture.value};
    const result=await postRelay(config,signingKey,body,fetchImpl,now);
    if(result.kind!=='answer'){
      retry||=result.kind==='retry';
      console.warn('notify.staff_action',{project:config.project,gesture:target.gesture,outcome:result.code});
      continue;
    }
    const outcome=typeof result.answer.outcome==='string'?result.answer.outcome.slice(0,32):'unknown';
    console.info('notify.staff_action',{project:config.project,gesture:target.gesture,outcome});
    // A code link already says "linked" in its own follow-up: no second notice.
    const notice=outcome==='linked'?null:renderLinkedNotice(result.answer);
    if(notice)await postFollowUp(env,db,gesture,notice,target.quoted,fetchImpl,now);
    const text=renderFollowUp(result.answer,config.timeZone);
    if(!text)continue;
    if(outcome==='not_linked'&&!await reserveReminder(db,config.project,fingerprint,config.timeZone,now))continue;
    await postFollowUp(env,db,gesture,text,target.quoted,fetchImpl,now);
  }
  return retry?reply(503,{error:'RELAY_RETRY'}):reply(200,{accepted:true,relayed:targets.length});
}
