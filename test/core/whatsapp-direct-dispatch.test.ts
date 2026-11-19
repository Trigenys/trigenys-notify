import assert from 'node:assert/strict';
import test from 'node:test';
import {dispatchWhatsAppDirect,type WhatsAppDirectEnv} from '../../src/core/whatsapp-direct-dispatch.js';
import {maskRecipient,recipientChatId,E164_PATTERN} from '../../src/core/whatsapp-direct-contracts.js';
import {routingDb} from '../support/notify-db.js';

const key='S'.repeat(48),now=Date.parse('2026-11-09T12:00:00.000Z');
const id='c'.repeat(64),other='d'.repeat(64);
const signer='+237650000001',issuer='+33612345678';
const event=(over:Record<string,unknown>={},message:Record<string,unknown>={})=>({version:1,project:'trigenys-sign',id,
  occurredAt:'2026-11-09T11:59:00.000Z',expiresAt:'2026-11-09T12:59:00.000Z',recipient:signer,
  message:{text:'Un document attend votre signature : Contrat cadre 2026',link:'https://sign.example.com/s/42',linkLabel:'Signer',...message},...over});
const request=(payload:unknown=event(),auth=key,project='trigenys-sign',headers:Record<string,string>={})=>
  new Request(`https://notify.example/v1/dispatch/${project}/whatsapp-direct`,{method:'POST',
    headers:{'content-type':'application/json','x-notify-auth':auth,...headers},body:typeof payload==='string'?payload:JSON.stringify(payload)});
const policy=(over:Record<string,unknown>={},limits:Record<string,unknown>={})=>JSON.stringify({'trigenys-sign':{enabled:true,limits:{perHour:10,perRecipientPerHour:2,...limits},...over}});
const settings=(db:WhatsAppDirectEnv['NOTIFY_DB'],over:Partial<WhatsAppDirectEnv>={}):WhatsAppDirectEnv=>({NOTIFY_DB:db,
  WHATSAPP_DIRECT_DISPATCH_ENABLED:'true',WAHA_BASE_URL:'https://notify.trigenys.com',WAHA_API_KEY:'K'.repeat(64),
  WAHA_SESSION:'trigenys-test',WHATSAPP_DIRECT_TRIGENYS_SIGN_INGEST_KEY:key,WHATSAPP_DIRECT_PROJECTS_JSON:policy(),...over});
function provider(status:(n:number)=>number|'throw'=()=>201){
  const sends:{url:string;body:Record<string,unknown>;apiKey:string|null}[]=[];
  const http=(async(url:RequestInfo|URL,init?:RequestInit)=>{
    const body=JSON.parse(String(init?.body));
    sends.push({url:String(url),body,apiKey:new Headers(init?.headers).get('x-api-key')});
    const code=status(sends.length);
    if(code==='throw')throw new TypeError('fetch failed');
    return new Response('{}',{status:code});
  }) as typeof fetch;
  return {http,sends};
}
const status=async(response:Response)=>[response.status,(await response.json()).error];
function captureLogs(t:{after(fn:()=>void):void}){
  const lines:unknown[][]=[];const original=console.info;
  console.info=(...args:unknown[])=>{lines.push(args);};
  t.after(()=>{console.info=original;});
  return lines;
}

test('E.164 recipients map to WAHA individual chat ids and are masked in logs',()=>{
  assert.equal(recipientChatId('+237650000001'),'237650000001@c.us');
  assert.equal(maskRecipient('+237650000001'),'***0001');
  for(const bad of ['237650000001','+0237650000001','+1234567','+1234567890123456','+33 6 12 34 56 78','+33612345678@c.us','120363000000000001@g.us'])
    assert.equal(E164_PATTERN.test(bad),false,bad);
  assert.throws(()=>recipientChatId('120363000000000001@g.us'));
});

test('sends the rendered text to the individual chat and answers 202 accepted',async t=>{
  const data=routingDb('0005');t.after(data.close);const p=provider();const logs=captureLogs(t);
  const response=await dispatchWhatsAppDirect(request(),settings(data.db),p.http,now);
  assert.equal(response.status,202);
  assert.deepEqual(await response.json(),{accepted:true,project:'trigenys-sign',channel:'whatsapp_direct',eventId:id});
  assert.equal(p.sends.length,1);
  assert.equal(p.sends[0].url,'https://notify.trigenys.com/api/sendText');
  assert.deepEqual(p.sends[0].body,{session:'trigenys-test',chatId:'237650000001@c.us',linkPreview:false,
    text:'Un document attend votre signature : Contrat cadre 2026\n\n🔗 Signer\nhttps://sign.example.com/s/42'});
  assert.equal(p.sends[0].apiKey,'K'.repeat(64));
  // Trace carries the masked number only: no key, no text, no full number.
  const serialized=JSON.stringify(logs);
  assert.equal(logs.length,1);assert.equal(logs[0][0],'notify.whatsapp_direct');
  assert.match(serialized,/\*\*\*0001/);
  for(const secret of [signer,'237650000001',key,'Contrat cadre','sign.example.com'])assert.equal(serialized.includes(secret),false,secret);
  // The ledger stores fingerprints only.
  const row=f(data.sqlite.prepare('SELECT * FROM notify_whatsapp_direct_deliveries').get());
  assert.equal(row.state,'accepted');assert.equal(row.attempts,1);
  for(const secret of ['237650000001',key,'Contrat cadre','sign.example.com'])assert.equal(JSON.stringify(row).includes(secret),false,secret);
});
const f=(row:unknown)=>({...(row as Record<string,unknown>)});

test('text without link is sent verbatim and linkLabel requires link',async t=>{
  const data=routingDb('0005');t.after(data.close);const p=provider();captureLogs(t);
  const env=settings(data.db);
  assert.equal((await dispatchWhatsAppDirect(request(event({},{text:'Il manque 2 signatures sur Contrat cadre 2026.',link:undefined,linkLabel:undefined})),env,p.http,now)).status,202);
  assert.equal(p.sends[0].body.text,'Il manque 2 signatures sur Contrat cadre 2026.');
  assert.deepEqual(await status(await dispatchWhatsAppDirect(request(event({id:other},{link:undefined})),env,p.http,now)),[400,'INVALID_WHATSAPP_EVENT']);
});

test('replays are idempotent: same id and content 202 without resend, different content 409',async t=>{
  const data=routingDb('0005');t.after(data.close);const p=provider();captureLogs(t);
  const env=settings(data.db);
  assert.equal((await dispatchWhatsAppDirect(request(),env,p.http,now)).status,202);
  assert.equal((await dispatchWhatsAppDirect(request(),env,p.http,now)).status,202);
  assert.equal(p.sends.length,1);
  assert.deepEqual(await status(await dispatchWhatsAppDirect(request(event({},{text:'Autre'})),env,p.http,now)),[409,'EVENT_ID_REUSED']);
  assert.deepEqual(await status(await dispatchWhatsAppDirect(request(event({recipient:issuer})),env,p.http,now)),[409,'EVENT_ID_REUSED']);
  assert.equal(p.sends.length,1);
});

test('WAHA outcomes map to 503 retryable, 502 final, and retries are capped',async t=>{
  const data=routingDb('0005');t.after(data.close);captureLogs(t);
  const env=settings(data.db);
  // Retryable: 503, 429, network failure; each replay with the same envelope resends until accepted.
  const flaky=provider(n=>n===1?503:n===2?429:n===3?'throw':201);
  assert.deepEqual(await status(await dispatchWhatsAppDirect(request(),env,flaky.http,now)),[503,'PROVIDER_UNAVAILABLE']);
  assert.deepEqual(await status(await dispatchWhatsAppDirect(request(),env,flaky.http,now)),[503,'RATE_LIMITED']);
  assert.deepEqual(await status(await dispatchWhatsAppDirect(request(),env,flaky.http,now)),[503,'NETWORK_TRANSPORT']);
  // Third failed attempt exhausts the safe-retry budget: no fourth send, caller is told to resolve.
  assert.deepEqual(await status(await dispatchWhatsAppDirect(request(),env,flaky.http,now)),[503,'DELIVERY_UNRESOLVED']);
  assert.equal(flaky.sends.length,3);
  // Final provider refusal (e.g. number not on WhatsApp) is 502 and never resent.
  const refused=provider(()=>400);
  assert.deepEqual(await status(await dispatchWhatsAppDirect(request(event({id:other})),env,refused.http,now)),[502,'PROVIDER_REJECTED']);
  assert.deepEqual(await status(await dispatchWhatsAppDirect(request(event({id:other})),env,refused.http,now)),[502,'PROVIDER_REJECTED']);
  assert.equal(refused.sends.length,1);
  // A second attempt that succeeds leaves exactly one accepted receipt.
  const fresh=routingDb('0005');t.after(fresh.close);
  const recover=provider(n=>n===1?503:201);
  assert.equal((await dispatchWhatsAppDirect(request(),settings(fresh.db),recover.http,now)).status,503);
  assert.equal((await dispatchWhatsAppDirect(request(),settings(fresh.db),recover.http,now)).status,202);
  assert.deepEqual(f(fresh.sqlite.prepare('SELECT state,attempts FROM notify_whatsapp_direct_deliveries').get()),{state:'accepted',attempts:2});
});

test('hourly limits apply per recipient and per project without consuming attempts',async t=>{
  const data=routingDb('0005');t.after(data.close);const p=provider();captureLogs(t);
  const env=settings(data.db,{WHATSAPP_DIRECT_PROJECTS_JSON:policy({},{perHour:3,perRecipientPerHour:2})});
  const ids=['1','2','3','4'].map(n=>n.repeat(64));
  assert.equal((await dispatchWhatsAppDirect(request(event({id:ids[0]})),env,p.http,now)).status,202);
  assert.equal((await dispatchWhatsAppDirect(request(event({id:ids[1]})),env,p.http,now)).status,202);
  const limited=await dispatchWhatsAppDirect(request(event({id:ids[2]})),env,p.http,now);
  assert.equal(limited.status,429);assert.equal(limited.headers.get('retry-after'),'60');
  assert.deepEqual(await limited.json(),{error:'RATE_LIMITED',scope:'recipient'});
  // Another recipient is still allowed until the project budget is spent.
  assert.equal((await dispatchWhatsAppDirect(request(event({id:ids[2],recipient:issuer})),env,p.http,now)).status,202);
  assert.deepEqual(await status(await dispatchWhatsAppDirect(request(event({id:ids[3],recipient:'+33698765432'})),env,p.http,now)),[429,'RATE_LIMITED']);
  assert.equal(p.sends.length,3);
  // A refused event leaves no receipt; it is accepted once the window has moved on.
  assert.equal(f(data.sqlite.prepare('SELECT count(*) AS n FROM notify_whatsapp_direct_deliveries').get()).n,3);
  assert.equal((await dispatchWhatsAppDirect(request(event({id:ids[3],recipient:'+33698765432',occurredAt:'2026-11-09T13:00:30.000Z',expiresAt:'2026-11-09T14:00:00.000Z'})),env,p.http,now+3660000)).status,202);
  // Replaying an already accepted event is never rate limited.
  assert.equal((await dispatchWhatsAppDirect(request(event({id:ids[0]})),env,p.http,now)).status,202);
  assert.equal(p.sends.length,4);
});

test('authentication is per project and per channel; undeclared projects are refused',async t=>{
  const data=routingDb('0005');t.after(data.close);const p=provider();captureLogs(t);
  assert.deepEqual(await status(await dispatchWhatsAppDirect(request(event(),'x'.repeat(48)),settings(data.db),p.http,now)),[401,'UNAUTHORIZED']);
  assert.deepEqual(await status(await dispatchWhatsAppDirect(request(event(),''),settings(data.db),p.http,now)),[401,'UNAUTHORIZED']);
  // Email or group WhatsApp keys for the same project do not authorize a 1:1 message.
  const otherChannel=settings(data.db,{WHATSAPP_DIRECT_TRIGENYS_SIGN_INGEST_KEY:undefined,EMAIL_TRIGENYS_SIGN_INGEST_KEY:key,WHATSAPP_TRIGENYS_SIGN_INGEST_KEY:key});
  assert.deepEqual(await status(await dispatchWhatsAppDirect(request(),otherChannel,p.http,now)),[503,'INGEST_NOT_CONFIGURED']);
  assert.deepEqual(await status(await dispatchWhatsAppDirect(request(),settings(data.db,{WHATSAPP_DIRECT_TRIGENYS_SIGN_INGEST_KEY:'short'}),p.http,now)),[503,'INGEST_NOT_CONFIGURED']);
  // A valid key for another project cannot post for this one.
  const twoProjects=settings(data.db,{WHATSAPP_DIRECT_OTHER_APP_INGEST_KEY:'O'.repeat(48)});
  assert.deepEqual(await status(await dispatchWhatsAppDirect(request(event(),'O'.repeat(48)),twoProjects,p.http,now)),[401,'UNAUTHORIZED']);
  // A key exists but the project is not declared in the policy: 403.
  assert.deepEqual(await status(await dispatchWhatsAppDirect(request(),settings(data.db,{WHATSAPP_DIRECT_PROJECTS_JSON:'{}'}),p.http,now)),[403,'PROJECT_NOT_ALLOWED']);
  assert.deepEqual(await status(await dispatchWhatsAppDirect(request(event(),key,'other-app'),twoProjects,p.http,now)),[401,'UNAUTHORIZED']);
  assert.deepEqual(await status(await dispatchWhatsAppDirect(request(event(),'O'.repeat(48),'other-app'),twoProjects,p.http,now)),[403,'PROJECT_NOT_ALLOWED']);
  assert.equal((await dispatchWhatsAppDirect(request(event(),key,'Bad_Project'),settings(data.db),p.http,now)).status,404);
  assert.equal((await dispatchWhatsAppDirect(new Request('https://notify.example/v1/dispatch/trigenys-sign/whatsapp-direct',{method:'GET'}),settings(data.db),p.http,now)).status,405);
  assert.equal(p.sends.length,0);
});

test('channel opt-in, limits and provider settings fail closed before any send',async t=>{
  const data=routingDb('0005');t.after(data.close);const p=provider();captureLogs(t);
  const cases:[Partial<WhatsAppDirectEnv>,string][]=[
    [{WHATSAPP_DIRECT_DISPATCH_ENABLED:'false'},'CHANNEL_DISABLED'],
    [{WHATSAPP_DIRECT_PROJECTS_JSON:policy({enabled:false})},'CHANNEL_DISABLED'],
    [{WHATSAPP_DIRECT_PROJECTS_JSON:'not json'},'WHATSAPP_DIRECT_NOT_CONFIGURED'],
    [{WHATSAPP_DIRECT_PROJECTS_JSON:JSON.stringify({'trigenys-sign':{enabled:true}})},'WHATSAPP_DIRECT_NOT_CONFIGURED'],
    [{WHATSAPP_DIRECT_PROJECTS_JSON:policy({},{perHour:0})},'WHATSAPP_DIRECT_NOT_CONFIGURED'],
    [{WHATSAPP_DIRECT_PROJECTS_JSON:policy({},{perRecipientPerHour:'5'})},'WHATSAPP_DIRECT_NOT_CONFIGURED'],
    [{WHATSAPP_DIRECT_PROJECTS_JSON:policy({groups:['120363000000000001@g.us']})},'WHATSAPP_DIRECT_NOT_CONFIGURED'],
    [{NOTIFY_DB:undefined},'WHATSAPP_DIRECT_NOT_CONFIGURED'],
    [{WAHA_API_KEY:undefined},'WHATSAPP_DIRECT_NOT_CONFIGURED'],
    [{WAHA_API_KEY:'short'},'WHATSAPP_DIRECT_NOT_CONFIGURED'],
    [{WAHA_BASE_URL:'http://notify.trigenys.com'},'WHATSAPP_DIRECT_NOT_CONFIGURED'],
    [{WAHA_SESSION:undefined},'WHATSAPP_DIRECT_NOT_CONFIGURED'],
    [{WAHA_SESSION:'bad session!'},'WHATSAPP_DIRECT_NOT_CONFIGURED']
  ];
  for(const [over,code]of cases)assert.deepEqual(await status(await dispatchWhatsAppDirect(request(),settings(data.db,over),p.http,now)),[503,code],JSON.stringify(over));
  assert.equal(p.sends.length,0);
  assert.equal(f(data.sqlite.prepare('SELECT count(*) AS n FROM notify_whatsapp_direct_deliveries').get()).n,0);
});

test('envelope validation refuses bad recipients, stale events, long or unsafe content and extra fields',async t=>{
  const data=routingDb('0005');t.after(data.close);const p=provider();captureLogs(t);
  const env=settings(data.db);
  const invalid:unknown[]=[
    event({recipient:'237650000001'}),event({recipient:'+0237650000001'}),event({recipient:'+1234567'}),
    event({recipient:'+1234567890123456'}),event({recipient:'237650000001@c.us'}),event({recipient:'120363000000000001@g.us'}),
    event({recipient:'merchant@example.com'}),event({recipient:undefined}),
    event({project:'other-app'}),event({version:2}),event({id:'abc'}),event({id:id.toUpperCase()}),
    event({occurredAt:'2026-11-09T11:54:00.000Z'}),event({occurredAt:'2026-11-09T12:02:00.000Z'}),
    event({expiresAt:'2026-11-09T11:30:00.000Z'}),event({expiresAt:'2026-11-10T12:30:00.000Z'}),
    event({},{text:''}),event({},{text:'   '}),event({},{text:'x'.repeat(3001)}),event({},{text:'tab\there'}),
    event({},{link:'http://sign.example.com/s/42'}),event({},{link:'javascript:alert(1)'}),event({},{link:'https://user:pw@sign.example.com/'}),
    event({},{linkLabel:'x'.repeat(81)}),event({},{linkLabel:'two\nlines'}),
    event({chatId:'237650000001@c.us'}),event({},{html:'<b>x</b>'}),[event()],'"string"','{bad json'
  ];
  for(const payload of invalid)assert.deepEqual(await status(await dispatchWhatsAppDirect(request(payload),env,p.http,now)),[400,'INVALID_WHATSAPP_EVENT'],JSON.stringify(payload).slice(0,80));
  // Exactly 3000 characters and a bare 8-digit number are accepted.
  assert.equal((await dispatchWhatsAppDirect(request(event({recipient:'+12345678'},{text:'y'.repeat(3000),link:undefined,linkLabel:undefined})),env,p.http,now)).status,202);
  assert.deepEqual(await status(await dispatchWhatsAppDirect(request(event(),key,'trigenys-sign',{'content-type':'text/plain'}),env,p.http,now)),[415,'JSON_REQUIRED']);
  assert.deepEqual(await status(await dispatchWhatsAppDirect(request(event(),key,'trigenys-sign',{'content-length':'9000'}),env,p.http,now)),[413,'BODY_TOO_LARGE']);
  assert.deepEqual(await status(await dispatchWhatsAppDirect(request(event({id:other},{text:'z'.repeat(2900),link:'https://sign.example.com/'+'a'.repeat(1000)})),env,p.http,now)),[400,'INVALID_WHATSAPP_EVENT']);
  assert.equal(p.sends.length,1);
});
