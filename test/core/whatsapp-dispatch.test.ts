import assert from 'node:assert/strict';
import test from 'node:test';
import {dispatchWhatsApp,type WhatsAppEnv} from '../../src/core/whatsapp-dispatch.js';
import {routingDb} from '../support/notify-db.js';

const key='S'.repeat(48),now=Date.parse('2026-11-09T12:00:00.000Z');
const one='120363000000000001@g.us',two='120363000000000002@g.us';
const origin='https://studio.example.com';
const id='b'.repeat(64);
const event=(over:Record<string,unknown>={},message:Record<string,unknown>={})=>({version:1,project:'trigenys-studio',id,
  occurredAt:'2026-11-09T11:59:00.000Z',expiresAt:'2026-11-09T12:59:00.000Z',
  message:{text:'Nouvelle tâche assignée : Maquette accueil',link:origin+'/tasks/42',linkLabel:'Ouvrir la tâche',...message},...over});
const request=(payload:unknown=event(),auth=key,project='trigenys-studio',headers:Record<string,string>={})=>
  new Request(`https://notify.example/v1/dispatch/${project}/whatsapp`,{method:'POST',
    headers:{'content-type':'application/json','x-notify-auth':auth,...headers},body:JSON.stringify(payload)});
const policy=(over:Record<string,unknown>={})=>JSON.stringify({'trigenys-studio':{enabled:true,groups:[one],allowedLinkOrigins:[origin],...over}});
const settings=(db:WhatsAppEnv['NOTIFY_DB'],over:Partial<WhatsAppEnv>={}):WhatsAppEnv=>({NOTIFY_DB:db,
  WAHA_DISPATCH_ENABLED:'true',WAHA_BASE_URL:'https://notify.trigenys.com',WAHA_API_KEY:'K'.repeat(64),
  WAHA_SESSION:'trigenys-test',WHATSAPP_TRIGENYS_STUDIO_INGEST_KEY:key,WHATSAPP_PROJECTS_JSON:policy(),...over});
function provider(status:(chatId:string,n:number)=>number=()=>201){
  const sends:{url:string;body:Record<string,unknown>;apiKey:string|null}[]=[];
  const http=(async(url:RequestInfo|URL,init?:RequestInit)=>{
    const body=JSON.parse(String(init?.body));
    sends.push({url:String(url),body,apiKey:new Headers(init?.headers).get('x-api-key')});
    return new Response('{}',{status:status(body.chatId,sends.filter(s=>s.body.chatId===body.chatId).length)});
  }) as typeof fetch;
  return {http,sends};
}
const status=async(response:Response)=>[response.status,(await response.json()).error];

test('sends the rendered text only to the declared group and answers 202 accepted',async t=>{
  const data=routingDb();t.after(data.close);const p=provider();
  const response=await dispatchWhatsApp(request(),settings(data.db),p.http,now);
  assert.equal(response.status,202);
  assert.deepEqual(await response.json(),{accepted:true,project:'trigenys-studio',channel:'whatsapp_waha',
    eventId:id,recipients:1,acceptedRecipients:1});
  assert.equal(p.sends.length,1);
  assert.equal(p.sends[0].url,'https://notify.trigenys.com/api/sendText');
  assert.deepEqual(p.sends[0].body,{session:'trigenys-test',chatId:one,linkPreview:false,
    text:'Nouvelle tâche assignée : Maquette accueil\n\n🔗 Ouvrir la tâche\nhttps://studio.example.com/tasks/42'});
  assert.equal(p.sends[0].apiKey,'K'.repeat(64));
});

test('retries are idempotent; partial failure only resends to the failed group',async t=>{
  const data=routingDb();t.after(data.close);
  const p=provider((chatId,n)=>chatId===two&&n===1?503:201);
  const env=settings(data.db,{WHATSAPP_PROJECTS_JSON:policy({groups:[one,{groupId:two}]})});
  assert.deepEqual(await status(await dispatchWhatsApp(request(),env,p.http,now)),[503,'PROVIDER_UNAVAILABLE']);
  assert.equal((await dispatchWhatsApp(request(),env,p.http,now)).status,202);
  assert.equal((await dispatchWhatsApp(request(),env,p.http,now)).status,202);
  assert.equal(p.sends.filter(s=>s.body.chatId===one).length,1);
  assert.equal(p.sends.filter(s=>s.body.chatId===two).length,2);
  // Reusing the id with different content is a conflict, never a second message.
  assert.deepEqual(await status(await dispatchWhatsApp(request(event({},{text:'Autre'})),env,p.http,now)),[409,'EVENT_ID_REUSED']);
  assert.equal(p.sends.length,3);
});

test('the recipient list is frozen per event and cannot gain groups added later',async t=>{
  const data=routingDb();t.after(data.close);const p=provider(()=>503);
  await dispatchWhatsApp(request(),settings(data.db),p.http,now);
  const widened=settings(data.db,{WHATSAPP_PROJECTS_JSON:policy({groups:[one,two]})});
  const ok=provider();
  assert.equal((await dispatchWhatsApp(request(),widened,ok.http,now)).status,202);
  assert.deepEqual(ok.sends.map(s=>s.body.chatId),[one]);
  // A group removed from the policy is skipped: old events never reach it.
  const fresh=routingDb();t.after(fresh.close);
  await dispatchWhatsApp(request(),settings(fresh.db),provider(()=>503).http,now);
  const removed=settings(fresh.db,{WHATSAPP_PROJECTS_JSON:policy({groups:[two]})});
  const none=provider();
  assert.deepEqual(await status(await dispatchWhatsApp(request(),removed,none.http,now)),[503,'GROUP_ROUTE_UNASSIGNED']);
  assert.equal(none.sends.length,0);
});

test('authentication is per project and per channel, and fails closed when unconfigured',async t=>{
  const data=routingDb();t.after(data.close);const p=provider();
  assert.deepEqual(await status(await dispatchWhatsApp(request(event(),'x'.repeat(48)),settings(data.db),p.http,now)),[401,'UNAUTHORIZED']);
  // An email key for the same project does not authorize WhatsApp.
  const emailOnly=settings(data.db,{WHATSAPP_TRIGENYS_STUDIO_INGEST_KEY:undefined,EMAIL_TRIGENYS_STUDIO_INGEST_KEY:key});
  assert.deepEqual(await status(await dispatchWhatsApp(request(),emailOnly,p.http,now)),[503,'INGEST_NOT_CONFIGURED']);
  // A key of another project cannot post for this one.
  const other=settings(data.db,{WHATSAPP_OTHER_APP_INGEST_KEY:'O'.repeat(48),
    WHATSAPP_PROJECTS_JSON:JSON.stringify({'other-app':{enabled:true,groups:[two]},'trigenys-studio':{enabled:true,groups:[one]}})});
  assert.deepEqual(await status(await dispatchWhatsApp(request(event(),'O'.repeat(48)),other,p.http,now)),[401,'UNAUTHORIZED']);
  assert.equal((await dispatchWhatsApp(request(event({project:'other-app'}),key,'other-app'),other,p.http,now)).status,401);
  // The envelope project must match the authenticated route.
  assert.deepEqual(await status(await dispatchWhatsApp(request(event(),'O'.repeat(48),'other-app'),other,p.http,now)),[400,'INVALID_WHATSAPP_EVENT']);
  // Dedicated products keep their own route and receipts.
  assert.equal((await dispatchWhatsApp(request(event({project:'xeption'}),key,'xeption'),settings(data.db,{WHATSAPP_XEPTION_INGEST_KEY:key}),p.http,now)).status,404);
  assert.equal((await dispatchWhatsApp(new Request('https://notify.example/v1/dispatch/trigenys-studio/whatsapp'),settings(data.db),p.http,now)).status,405);
  assert.equal(p.sends.length,0);
});

test('the channel is opt-in per project and globally, with a non-empty group allowlist',async t=>{
  const data=routingDb();t.after(data.close);const p=provider();
  const cases:[Partial<WhatsAppEnv>,number,string][]=[
    [{WAHA_DISPATCH_ENABLED:'false'},503,'CHANNEL_DISABLED'],
    [{WHATSAPP_PROJECTS_JSON:policy({enabled:false})},503,'CHANNEL_DISABLED'],
    [{WHATSAPP_PROJECTS_JSON:'{}'},503,'CHANNEL_DISABLED'],
    [{WHATSAPP_PROJECTS_JSON:undefined},503,'CHANNEL_DISABLED'],
    [{WHATSAPP_PROJECTS_JSON:policy({groups:[]})},503,'GROUP_ROUTE_UNASSIGNED'],
    [{WHATSAPP_PROJECTS_JSON:policy({groups:['+237600000000']})},503,'WHATSAPP_NOT_CONFIGURED'],
    [{WHATSAPP_PROJECTS_JSON:policy({groups:['237600000000@c.us']})},503,'WHATSAPP_NOT_CONFIGURED'],
    [{WHATSAPP_PROJECTS_JSON:policy({allowedLinkOrigins:['http://studio.example.com']})},503,'WHATSAPP_NOT_CONFIGURED'],
    [{WHATSAPP_PROJECTS_JSON:'not json'},503,'WHATSAPP_NOT_CONFIGURED'],
    [{NOTIFY_DB:undefined},503,'WHATSAPP_NOT_CONFIGURED'],
    [{WAHA_API_KEY:undefined},503,'WHATSAPP_NOT_CONFIGURED'],
  ];
  for(const [over,code,error] of cases)
    assert.deepEqual(await status(await dispatchWhatsApp(request(),settings(data.db,over),p.http,now)),[code,error],JSON.stringify(over));
  // An unsafe provider origin fails before any durable claim.
  assert.deepEqual(await status(await dispatchWhatsApp(request(),settings(data.db,{WAHA_BASE_URL:'http://waha.local'}),p.http,now)),[503,'WHATSAPP_NOT_CONFIGURED']);
  assert.equal(data.sqlite.prepare('SELECT count(*) AS n FROM notify_whatsapp_receipts').get()?.n,0);
  assert.equal(p.sends.length,0);
});

test('the envelope, freshness, destination and link origin are validated before sending',async t=>{
  const data=routingDb();t.after(data.close);const p=provider();
  const invalid:[unknown,number,string][]=[
    [event({id:'B'.repeat(64)}),400,'INVALID_WHATSAPP_EVENT'],
    [event({version:2}),400,'INVALID_WHATSAPP_EVENT'],
    [event({project:'other'}),400,'INVALID_WHATSAPP_EVENT'],
    [event({occurredAt:'2026-11-09T11:54:59.000Z'}),400,'INVALID_WHATSAPP_EVENT'],
    [event({occurredAt:'2026-11-09T12:01:01.000Z',expiresAt:'2026-11-09T13:00:00.000Z'}),400,'INVALID_WHATSAPP_EVENT'],
    [event({expiresAt:'2026-11-09T11:59:30.000Z'}),400,'INVALID_WHATSAPP_EVENT'],
    [event({expiresAt:'2026-11-10T11:59:00.001Z'}),400,'INVALID_WHATSAPP_EVENT'],
    [event({chatId:two}),400,'INVALID_WHATSAPP_EVENT'],
    [event({recipient:'+237600000000'}),400,'INVALID_WHATSAPP_EVENT'],
    [event({},{chatId:two}),400,'INVALID_WHATSAPP_EVENT'],
    [event({},{text:'  '}),400,'INVALID_WHATSAPP_EVENT'],
    [event({},{text:'a\u0000b'}),400,'INVALID_WHATSAPP_EVENT'],
    [event({},{text:'x'.repeat(3001)}),400,'INVALID_WHATSAPP_EVENT'],
    [event({},{link:'https://evil.example/tasks/42'}),400,'LINK_ORIGIN_DENIED'],
    [event({},{link:'http://studio.example.com/tasks/42'}),400,'LINK_ORIGIN_DENIED'],
    [event({},{link:'https://user:pw@studio.example.com/'}),400,'LINK_ORIGIN_DENIED'],
    [event({},{link:undefined}),400,'INVALID_WHATSAPP_EVENT'],
    [event({},{linkLabel:'a\nb'}),400,'INVALID_WHATSAPP_EVENT'],
    [[event()],400,'INVALID_WHATSAPP_EVENT'],
  ];
  for(const [payload,code,error] of invalid)
    assert.deepEqual(await status(await dispatchWhatsApp(request(payload),settings(data.db),p.http,now)),[code,error],JSON.stringify(payload));
  assert.deepEqual(await status(await dispatchWhatsApp(request(event(),key,'trigenys-studio',{'content-type':'text/plain'}),settings(data.db),p.http,now)),[415,'JSON_REQUIRED']);
  assert.deepEqual(await status(await dispatchWhatsApp(request({...event(),pad:'x'.repeat(9000)}),settings(data.db),p.http,now)),[413,'BODY_TOO_LARGE']);
  assert.equal(p.sends.length,0);
  // A text-only message without link is accepted and sent verbatim.
  const plain=event({id:'c'.repeat(64),message:{text:'Rappel : revue à 15 h'}});
  assert.equal((await dispatchWhatsApp(request(plain),settings(data.db,{WHATSAPP_PROJECTS_JSON:policy({allowedLinkOrigins:undefined})}),p.http,now)).status,202);
  assert.equal(p.sends[0].body.text,'Rappel : revue à 15 h');
});

test('errors never echo keys, group ids, provider bodies or message content',async t=>{
  const data=routingDb();t.after(data.close);
  const http=(async()=>new Response('provider secret detail',{status:400})) as unknown as typeof fetch;
  const response=await dispatchWhatsApp(request(),settings(data.db),http,now);
  const body=await response.text();
  assert.equal(response.status,502);
  for(const leak of [key,'K'.repeat(64),one,'Maquette','provider secret'])assert.ok(!body.includes(leak));
  const row=data.sqlite.prepare('SELECT payload_hash FROM notify_whatsapp_events').get() as {payload_hash:string};
  assert.match(row.payload_hash,/^[a-f0-9]{64}$/);
});
