import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {handleGroupWebhook,reconcileGroups,handleGroupAdmin,type NotifyDatabase} from '../../src/core/group-routing.js';
import {handleStaffAction,parseStaffGesture,renderFollowUp,renderLinkedNotice,signRelay,actorFingerprint,normalizeActor,resolveActorPhone,
  relayConfigs,cleanupStaffActions,STAFF_ACTION_EVENTS,type StaffActionEnv} from '../../src/core/whatsapp-staff-actions.js';
import {routingDb} from '../support/notify-db.js';

// Shared vector with Xeption tests/whatsapp-order-actions.test.ts (same secret, timestamp and body).
const VECTOR_SECRET='s'.repeat(32),VECTOR_TS=String(1_800_000_000_000);
const VECTOR_RAW=JSON.stringify({version:1,id:'true_123@g.us_ABC_456@c.us',eventId:'00000000-0000-4000-8000-000000000001',
  groupKey:'staff',actor:{fingerprint:'a'.repeat(64)},gesture:'reaction',value:'✅'});
const VECTOR_SIGNATURE='377cf19f2d060d2ad3fd377a063503cb49505d796b9ba48bd97513cd13db4b31'+
  '85ae465e799497254518eeae6cee94bd0df371f72e40108698928eb10a50d7f5';

// Fictitious identifiers only: no real number, no real group.
const session='trigenys-test',group='120363000000000001@g.us',other='120363000000000002@g.us';
const AUTHOR='555000111222',ALERT_KEY='3EB0ALERT0000000001',EVENT_ID='00000000-0000-4000-8000-000000000001';
const admin='A'.repeat(48),hmacKey='W'.repeat(48);
const SIGNING='S'.repeat(40),LID='123456789012345@lid';
const RELAY_URL='https://consumer.example/functions/v1/notify-staff-action';
const NOW=Date.parse('2026-11-16T10:00:00Z');

const env=(db:NotifyDatabase,extra:Partial<StaffActionEnv>={}):StaffActionEnv=>({
  NOTIFY_DB:db,WAHA_SESSION:session,WAHA_WEBHOOK_HMAC_KEY:hmacKey,WAHA_BASE_URL:'https://notify.trigenys.com',
  WAHA_API_KEY:'K'.repeat(64),WHATSAPP_ACTIONS_ENABLED:'true',
  WHATSAPP_ACTION_RELAYS_JSON:JSON.stringify({xeption:{url:RELAY_URL}}),
  XEPTION_NOTIFY_ACTION_KEY:SIGNING,...extra});

async function setup(approved=true){
  const data=routingDb('0007');
  await reconcileGroups(data.db,session,[{id:group,name:'Xeption app test'},{id:other,name:'Autre'}]);
  if(approved){
    const r=await handleGroupAdmin(new Request('https://notify.example/v1/whatsapp/routes',{method:'POST',
      headers:{'x-notify-admin-key':admin},body:JSON.stringify({project:'xeption',session,groupId:group,enabled:true})}),
      {NOTIFY_DB:data.db,NOTIFY_ADMIN_KEY:admin,WAHA_SESSION:session});
    assert.equal(r.status,200);
  }
  data.sqlite.prepare(`INSERT INTO notify_whatsapp_events(project,event_id,payload_hash,recipients_json,created_at_ms)
    VALUES('xeption',?,'h','[]',0)`).run(EVENT_ID);
  data.sqlite.prepare(`INSERT INTO notify_whatsapp_receipts
    (project,event_id,session,group_id,state,claim_token,lease_until_ms,provider_message_id)
    VALUES('xeption',?,?,?,'accepted','t',0,?)`).run(EVENT_ID,session,group,ALERT_KEY);
  return data;
}
const reaction=(text='✅',over:Record<string,unknown>={})=>({id:'evt_01JTEST',event:'message.reaction',session,
  payload:{id:`false_${group}_3EB0REACT000000001_${AUTHOR}@c.us`,from:group,fromMe:false,
    participant:`${AUTHOR}:12@s.whatsapp.net`,reaction:{text,messageId:`true_${group}_${ALERT_KEY}`},...over}});
const message=(body:string,quoted?:string,over:Record<string,unknown>={})=>({id:'evt_01JTEXT',event:'message',session,
  payload:{id:`false_${group}_3EB0TEXT0000000001_${AUTHOR}@c.us`,from:group,fromMe:false,participant:`${AUTHOR}@c.us`,body,
    ...(quoted?{replyTo:{id:quoted,participant:'x'}}:{}),...over}});

interface Call {url:string;headers:Headers;body:string}
/** Fake network: the consumer answers `answer`, WAHA accepts every sendText with a fresh key. */
function network(answer:()=>Response|Promise<Response>,lidPn:string|null=null){
  const relays:Call[]=[],sends:Record<string,unknown>[]=[],lookups:string[]=[];
  let n=0;
  const fetchImpl=(async(input:RequestInfo|URL,init?:RequestInit)=>{
    const url=String(input),body=String(init?.body??'');
    if(url===RELAY_URL){relays.push({url,headers:new Headers(init?.headers),body});return answer();}
    if(url.includes('/lids/')){lookups.push(url);return new Response(JSON.stringify({lid:LID,pn:lidPn}),{status:200});}
    sends.push(JSON.parse(body));n++;
    return new Response(JSON.stringify({id:`true_${group}_3EB0FOLLOW00000000${n}`}),{status:201});
  }) as typeof fetch;
  return {fetchImpl,relays,sends,lookups};
}
const ok=(body:Record<string,unknown>)=>()=>new Response(JSON.stringify({ok:true,changed:true,at:'2026-11-16T13:05:00Z',...body}),{status:200});
function captureLogs(t:{after(fn:()=>void):void}){
  const lines:string[]=[];
  const original={info:console.info,warn:console.warn,log:console.log,error:console.error};
  for(const level of ['info','warn','log','error'] as const)
    console[level]=(...args:unknown[])=>{lines.push(JSON.stringify(args));};
  t.after(()=>Object.assign(console,original));
  return lines;
}

test('relay signature matches the vector shared with the consumer',async()=>{
  assert.equal(await signRelay(VECTOR_SECRET,VECTOR_TS,VECTOR_RAW),VECTOR_SIGNATURE);
  // Same algorithm as the consumer: key trimmed, `${timestamp}.${raw}`.
  assert.equal(createHmac('sha512',VECTOR_SECRET).update(VECTOR_TS+'.'+VECTOR_RAW).digest('hex'),VECTOR_SIGNATURE);
  assert.equal(await signRelay(' '+VECTOR_SECRET+'\n',VECTOR_TS,VECTOR_RAW),VECTOR_SIGNATURE);
});

test('gesture parsing keeps the message key and a normalized author only',()=>{
  const g=parseStaffGesture(reaction());
  assert.deepEqual(g,{session,groupId:group,id:'3EB0REACT000000001',actor:AUTHOR+'@c.us',kind:'reaction',value:'✅',quotedKey:ALERT_KEY});
  assert.equal(parseStaffGesture(reaction('')),null,'a removed reaction is no action');
  assert.equal(parseStaffGesture(reaction('✅',{fromMe:true})),null,'own messages are ignored');
  assert.equal(parseStaffGesture(reaction('✅',{from:AUTHOR+'@c.us'})),null,'direct chats are ignored');
  assert.equal(parseStaffGesture(reaction('✅',{participant:'nobody'})),null);
  assert.equal(parseStaffGesture({event:'group.v2.join',session,payload:{}}),null);
  // NOWEB raw quote context is understood when the documented replyTo is absent.
  const raw=parseStaffGesture(message('2',undefined,{_data:{message:{extendedTextMessage:{contextInfo:{stanzaId:ALERT_KEY}}}}}));
  assert.equal(raw?.quotedKey,ALERT_KEY);
  assert.equal(normalizeActor('123456789012345@lid'),'123456789012345@lid');
  assert.equal(normalizeActor(AUTHOR+':3@c.us'),AUTHOR+'@c.us');
});

test('a reaction to an alert is correlated, relayed signed, and answered under the alert',async t=>{
  const data=await setup();t.after(data.close);
  const logs=captureLogs(t);
  const net=network(ok({outcome:'delivered',action:'delivered',actor:'Anjl'}));
  const response=await handleStaffAction(reaction(),env(data.db),net.fetchImpl,NOW);
  assert.equal(response.status,200);
  assert.equal(net.relays.length,1);
  const [call]=net.relays,body=JSON.parse(call.body);
  assert.deepEqual(Object.keys(body),['version','id','eventId','groupKey','actor','gesture','value']);
  assert.equal(body.eventId,EVENT_ID);
  assert.equal(body.gesture,'reaction');
  assert.equal(body.id,'3EB0REACT000000001');
  assert.equal(body.actor.fingerprint,await actorFingerprint(SIGNING,AUTHOR));
  assert.match(body.groupKey,/^[0-9a-f]{64}$/);
  assert.ok(new TextEncoder().encode(call.body).length<=4096);
  assert.equal(call.headers.get('x-notify-timestamp'),String(NOW));
  assert.equal(call.headers.get('x-notify-signature'),
    createHmac('sha512',SIGNING).update(`${NOW}.${call.body}`).digest('hex'));
  // No phone number or chat id in the relayed body.
  assert.ok(!call.body.includes(AUTHOR)&&!call.body.includes('@c.us')&&!call.body.includes(group));
  // Follow-up: quoted reply to the alert, no emoji, first name and time only.
  assert.equal(net.sends.length,1);
  assert.equal(net.sends[0].reply_to,`true_${group}_${ALERT_KEY}`);
  assert.equal(net.sends[0].chatId,group);
  assert.equal(net.sends[0].text,'*Suivi commande*\nLivraison enregistrée par Anjl à 14:05.');
  // Logs: codes only, never the number, the fingerprint, the signature or the value.
  const joined=logs.join('\n');
  for(const secret of [AUTHOR,body.actor.fingerprint,call.headers.get('x-notify-signature')!,'✅',SIGNING])
    assert.ok(!joined.includes(secret));
  assert.match(joined,/notify\.staff_action.*delivered/);
});

test('a numeric reply to the follow-up line reaches the same event',async t=>{
  const data=await setup();t.after(data.close);
  const first=network(ok({outcome:'reason_required',action:'cancel_requested'}));
  await handleStaffAction(reaction('❌'),env(data.db),first.fetchImpl,NOW);
  assert.match(String(first.sends[0].text),/répondez à ce message par un chiffre de 1 à 5/);
  const second=network(ok({outcome:'cancelled',action:'cancelled',reason:'Client a renoncé',actor:'Anjl'}));
  await handleStaffAction(message('2',`true_${group}_3EB0FOLLOW000000001`),env(data.db),second.fetchImpl,NOW);
  assert.equal(second.relays.length,1);
  const body=JSON.parse(second.relays[0].body);
  assert.deepEqual([body.gesture,body.value,body.eventId],['reply','2',EVENT_ID]);
  assert.equal(second.sends[0].text,'*Suivi commande*\nAnnulation enregistrée par Anjl à 14:05. Motif : Client a renoncé.');
});

test('unapproved groups, uncorrelated messages and free text are ignored silently',async t=>{
  const data=await setup(false);t.after(data.close);
  const net=network(ok({outcome:'delivered'}));
  assert.equal((await handleStaffAction(reaction(),env(data.db),net.fetchImpl,NOW)).status,200);
  const approvedData=await setup();t.after(approvedData.close);
  await handleStaffAction(reaction('✅',{reaction:{text:'✅',messageId:`true_${group}_3EB0UNKNOWN00000001`}}),env(approvedData.db),net.fetchImpl,NOW);
  // The alert key exists, but in another group: no cross-group correlation.
  await handleStaffAction(reaction('✅',{from:other}),env(approvedData.db),net.fetchImpl,NOW);
  await handleStaffAction(message('Le client a payé en partie',`true_${group}_${ALERT_KEY}`),env(approvedData.db),net.fetchImpl,NOW);
  await handleStaffAction(message('bonjour'),env(approvedData.db),net.fetchImpl,NOW);
  await handleStaffAction(reaction(),env(approvedData.db,{WHATSAPP_ACTIONS_ENABLED:'false'}),net.fetchImpl,NOW);
  assert.equal(net.relays.length,0);
  assert.equal(net.sends.length,0);
});

test('a link code in an approved group is relayed without event id',async t=>{
  const data=await setup();t.after(data.close);
  const net=network(ok({outcome:'linked',action:'link',actor:'Anjl'}));
  await handleStaffAction(message('xl-ab2c-9xyz'),env(data.db),net.fetchImpl,NOW);
  const body=JSON.parse(net.relays[0].body);
  assert.deepEqual([body.gesture,body.value,body.eventId],['link','XL-AB2C-9XYZ','']);
  assert.equal(net.sends[0].text,'*Suivi commande*\nNuméro lié au compte de Anjl.');
  assert.equal(net.sends[0].reply_to,undefined);
});

test('only consumer 5xx (except 503), 429 and network errors ask WAHA to retry',async t=>{
  const data=await setup();t.after(data.close);
  const cases:[()=>Response|Promise<Response>,number][]=[
    [()=>new Response('{"error":"RPC_FAILED"}',{status:502}),503],
    [()=>{throw new TypeError('down');},503],
    [()=>new Response('{"error":"UNAUTHORIZED"}',{status:401}),200],
    [()=>new Response('{"error":"CHANNEL_DISABLED"}',{status:503}),200],
    [()=>new Response('{"error":"INVALID_RELAY"}',{status:400}),200]
  ];
  for(const [answer,status] of cases){
    const net=network(answer);
    assert.equal((await handleStaffAction(reaction(),env(data.db),net.fetchImpl,NOW)).status,status);
    assert.equal(net.sends.length,0,'no follow-up without a business answer');
  }
});

test('duplicates stay silent and the not-linked reminder is sent once per author per hour',async t=>{
  const data=await setup();t.after(data.close);
  const dup=network(ok({outcome:'duplicate',changed:false}));
  await handleStaffAction(reaction(),env(data.db),dup.fetchImpl,NOW);
  assert.equal(dup.sends.length,0);
  const net=network(ok({outcome:'not_linked',changed:false}));
  await handleStaffAction(reaction(),env(data.db),net.fetchImpl,NOW);
  await handleStaffAction(reaction('📵'),env(data.db),net.fetchImpl,NOW+60000);
  assert.equal(net.relays.length,2);
  assert.equal(net.sends.length,1);
  await handleStaffAction(reaction(),env(data.db),net.fetchImpl,NOW+3600000);
  assert.equal(net.sends.length,2,'a new hour allows a new reminder');
  await cleanupStaffActions(data.db,NOW+30*24*3600000);
  assert.equal((data.sqlite.prepare('SELECT count(*) AS n FROM notify_whatsapp_action_reminders').get() as {n:number}).n,0);
});

test('missing secrets or invalid configuration relay nothing',async t=>{
  const data=await setup();t.after(data.close);
  const net=network(ok({outcome:'delivered'}));
  await handleStaffAction(reaction(),env(data.db,{XEPTION_NOTIFY_ACTION_KEY:'short'}),net.fetchImpl,NOW);
  assert.equal(net.relays.length,0);
  assert.deepEqual(relayConfigs(env(data.db,{WHATSAPP_ACTION_RELAYS_JSON:'{"xeption":{"url":"http://plain.example"}}'})),[]);
  assert.deepEqual(relayConfigs(env(data.db,{WHATSAPP_ACTION_RELAYS_JSON:'not json'})),[]);
});

test('follow-up lines carry no emoji and strip formatting from the answer',()=>{
  const pictographic=/\p{Extended_Pictographic}/u;
  for(const outcome of ['delivered','cash_delivered','unreachable','cancelled','reason_required','needs_payment',
    'closed','not_linked','cancel_forbidden','linked','invalid_code']){
    const line=renderFollowUp({outcome,actor:'Anjl',attempt:2,reason:'Motif',at:'2026-11-16T13:05:00Z'});
    assert.ok(line&&!pictographic.test(line),outcome);
  }
  for(const outcome of ['duplicate','ignored','something_new',undefined])assert.equal(renderFollowUp({outcome}),null);
  assert.equal(renderFollowUp({outcome:'unreachable',attempt:3,actor:'*Anjl*\nX',at:'bad'}),
    '*Suivi commande*\nClient injoignable, tentative 3, noté par Anjl X.');
});

test('the group webhook hands staff events to the injected handler only',async t=>{
  const data=await setup();t.after(data.close);
  const config=env(data.db);
  const sign=async(body:string)=>new Request('https://notify.example/v1/whatsapp/groups/webhook',{method:'POST',body,headers:{
    'content-type':'application/json','x-webhook-hmac-algorithm':'sha512','x-webhook-timestamp':String(Date.now()),
    'x-webhook-hmac':createHmac('sha512',hmacKey).update(body).digest('hex')}});
  const net=network(ok({outcome:'delivered',actor:'Anjl'}));
  const extension={events:STAFF_ACTION_EVENTS,handle:(d:unknown)=>handleStaffAction(d,config,net.fetchImpl)};
  // Without the extension the historical contract is unchanged.
  assert.equal((await handleGroupWebhook(await sign(JSON.stringify(reaction())),config)).status,400);
  assert.equal((await handleGroupWebhook(await sign(JSON.stringify(reaction())),config,extension)).status,200);
  assert.equal(net.relays.length,1);
  assert.equal((await handleGroupWebhook(await sign(JSON.stringify({...reaction(),session:'other'})),config,extension)).status,400);
  const unsigned=await sign(JSON.stringify(reaction()));
  unsigned.headers.set('x-webhook-hmac','0'.repeat(128));
  assert.equal((await handleGroupWebhook(unsigned,config,extension)).status,401);
  assert.equal(net.relays.length,1);
});

test('actor fingerprint matches the vector shared with Xeption',async()=>{
  const key='k'.repeat(32),phone='237600000001';
  const expected=createHmac('sha256',key).update('wa-actor:v1:'+phone).digest('hex');
  assert.equal(await actorFingerprint(key,phone),expected);
  assert.equal(await actorFingerprint(' '+key+'\n',phone),expected);
});

test('the actor number is preferred over a LID and LIDs are resolved through WAHA',async()=>{
  const g=parseStaffGesture(reaction('✅',{participant:LID,_data:{key:{participantPn:AUTHOR+'@s.whatsapp.net'}}}));
  assert.equal(g?.actor,AUTHOR+'@c.us');
  const config=env((await setup()).db);
  const known=network(ok({}),AUTHOR+'@c.us');
  assert.equal(await resolveActorPhone(config,session,AUTHOR+':4@c.us',known.fetchImpl),AUTHOR);
  assert.equal(known.lookups.length,0,'a number needs no lookup');
  assert.equal(await resolveActorPhone(config,session,LID,known.fetchImpl),AUTHOR);
  assert.equal(known.lookups[0],`https://notify.trigenys.com/api/${session}/lids/${encodeURIComponent(LID)}`);
  const unknown=network(ok({}));
  assert.equal(await resolveActorPhone(config,session,LID,unknown.fetchImpl),undefined);
  const failing=(async()=>{throw new TypeError('down');}) as typeof fetch;
  assert.equal(await resolveActorPhone(config,session,LID,failing),undefined);

});

test('a LID resolved through WAHA is relayed with the number fingerprint',async t=>{
  const data=await setup();t.after(data.close);
  const net=network(ok({outcome:'delivered',actor:'Anjl'}),AUTHOR+'@c.us');
  await handleStaffAction(reaction('✅',{participant:LID}),env(data.db),net.fetchImpl,NOW);
  assert.equal(net.lookups.length,1);
  assert.equal(JSON.parse(net.relays[0].body).actor.fingerprint,await actorFingerprint(SIGNING,AUTHOR));
});

test('an unresolved LID relays nothing, asks no retry and logs no identifier',async t=>{
  const data=await setup();t.after(data.close);
  const logs=captureLogs(t);
  const net=network(ok({outcome:'delivered'}));
  const response=await handleStaffAction(reaction('✅',{participant:LID}),env(data.db),net.fetchImpl,NOW);
  assert.equal(response.status,200);
  assert.equal(net.relays.length,0);
  assert.equal(net.sends.length,0);
  const joined=logs.join('\n');
  assert.match(joined,/lid_unresolved/);
  assert.ok(!joined.includes('123456789012345'));
});

test('a first automatic link posts the recognition notice before the follow-up',async t=>{
  const data=await setup();t.after(data.close);
  const net=network(ok({outcome:'delivered',actor:'Anjl',linked:{actor:'Anjl',role:'manager_vente',store:'Akwa'}}));
  await handleStaffAction(reaction(),env(data.db),net.fetchImpl,NOW);
  assert.equal(net.sends.length,2);
  assert.match(String(net.sends[0].text),/^\*Suivi commande\*\nNuméro reconnu : \*Anjl\* \(Manager · Akwa\)\./);
  assert.match(String(net.sends[1].text),/Livraison enregistrée par Anjl/);
  assert.equal(net.sends[0].reply_to,`true_${group}_${ALERT_KEY}`);
});

test('linked notice and not-linked reasons carry no emoji',()=>{
  const pictographic=/\p{Extended_Pictographic}/u;
  for(const role of ['vendeur','editor','responsable','manager','manager_vente','other']){
    const line=renderLinkedNotice({outcome:'delivered',linked:{actor:'Anjl',role,store:'Akwa'}});
    assert.ok(line&&!pictographic.test(line),role);
  }
  assert.match(renderLinkedNotice({linked:{actor:'Anjl',role:'editor'}})!,/\(Vendeur\)/);
  assert.equal(renderLinkedNotice({outcome:'delivered'}),null);
  assert.equal(renderLinkedNotice({linked:{role:'manager'}}),null);
  const lines=new Set<string>();
  for(const reason of ['phone_not_found','phone_ambiguous','use_erp_code','no_account','staff_already_linked',
    'fingerprint_already_linked','unknown',undefined]){
    const line=renderFollowUp({outcome:'not_linked',link:{reason}});
    assert.ok(line&&!pictographic.test(line),String(reason));
    lines.add(line);
  }
  assert.equal(lines.size,6,'both "already linked" reasons share a line, unknown ones fall back to the default');
});
