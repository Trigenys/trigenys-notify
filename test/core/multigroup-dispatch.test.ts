import test from 'node:test';
import assert from 'node:assert/strict';
import {dispatchXeptionWhatsApp,type DispatchEnv} from '../../src/core/dispatch.js';
import {reconcileGroups,handleGroupAdmin} from '../../src/core/group-routing.js';
import {routingDb} from '../support/notify-db.js';

const session='trigenys-test',one='120001@g.us',two='120002@g.us',three='120003@g.us';
const admin='A'.repeat(48),key='I'.repeat(48);
const event={version:1,project:'xeption',id:'event111',type:'inventory.stock_low',
  occurredAt:'2026-10-21T10:00:00Z',priority:'high',resource:{kind:'inventory',id:'part001'},
  audience:'staff',actionUrl:'https://www.xeptionetwork.shop/admin/inventory'};
const request=(payload=event)=>new Request('https://notify.example/v1/dispatch/xeption/whatsapp',{
  method:'POST',headers:{'content-type':'application/json','x-notify-auth':key},body:JSON.stringify(payload)});
const settings=(db:DispatchEnv['NOTIFY_DB']):DispatchEnv=>({NOTIFY_DB:db,WAHA_DISPATCH_ENABLED:'true',
  XEPTION_NOTIFY_INGEST_KEY:key,WAHA_BASE_URL:'https://notify.trigenys.com',WAHA_API_KEY:'K'.repeat(64),
  WAHA_SESSION:session,WAHA_STAFF_GROUP_ID:'999999@g.us',WAHA_FALLBACK_PROJECTS:'xeption'});
async function authorize(db:DispatchEnv['NOTIFY_DB'],groupId:string,enabled=true){
  const result=await handleGroupAdmin(new Request('https://notify.example/v1/whatsapp/routes',{
    method:'POST',headers:{'x-notify-admin-key':admin},
    body:JSON.stringify({project:'xeption',session,groupId,enabled})
  }),{NOTIFY_DB:db,NOTIFY_ADMIN_KEY:admin,WAHA_SESSION:session});
  assert.equal(result.status,200);
}

test('fanout reaches every approved Xeption group; partial retry skips accepted recipients',async t=>{
  const data=routingDb();t.after(data.close);
  await reconcileGroups(data.db,session,[{id:one,name:'Xeption Dev'},{id:two,name:'Xeption Team'},{id:three,name:'Xeption Clients'}]);
  await authorize(data.db,one);await authorize(data.db,two);
  const sends=new Map<string,number>();
  const http=(async(url:RequestInfo|URL,init?:RequestInit)=>{
    assert.equal(String(url),'https://notify.trigenys.com/api/sendText');
    const body=JSON.parse(String(init?.body));
    sends.set(body.chatId,(sends.get(body.chatId)??0)+1);
    assert.notEqual(body.chatId,'999999@g.us');assert.notEqual(body.chatId,three);
    return new Response('{}',{status:body.chatId===two&&sends.get(two)===1?503:201});
  }) as typeof fetch;
  assert.equal((await dispatchXeptionWhatsApp(request(),settings(data.db),http)).status,503);
  assert.equal((await dispatchXeptionWhatsApp(request(),settings(data.db),http)).status,202);
  assert.equal(sends.get(one),1);assert.equal(sends.get(two),2);
  assert.equal((await dispatchXeptionWhatsApp(request(),settings(data.db),http)).status,202);
  assert.equal(sends.get(one),1);assert.equal(sends.get(two),2);
  const reused=await dispatchXeptionWhatsApp(request({...event,priority:'critical'}),settings(data.db),http);
  assert.equal(reused.status,409);assert.match(await reused.text(),/EVENT_ID_REUSED/);
});

test('newly approved groups do not receive old events on source retries',async t=>{
  const data=routingDb();t.after(data.close);
  await reconcileGroups(data.db,session,[{id:one,name:'Xeption Dev'},{id:two,name:'Xeption Team'}]);
  await authorize(data.db,one);
  const sent:string[]=[];
  const http=(async(_url:RequestInfo|URL,init?:RequestInit)=>{
    sent.push(JSON.parse(String(init?.body)).chatId);return new Response('{}',{status:201});
  }) as typeof fetch;
  assert.equal((await dispatchXeptionWhatsApp(request(),settings(data.db),http)).status,202);
  await authorize(data.db,two);
  assert.equal((await dispatchXeptionWhatsApp(request(),settings(data.db),http)).status,202);
  assert.deepEqual(sent,[one]);
  assert.equal((await dispatchXeptionWhatsApp(request({...event,id:'event222'}),settings(data.db),http)).status,202);
  assert.deepEqual(sent,[one,one,two]);
});

test('concurrent dispatches claim each recipient only once',async t=>{
  const data=routingDb();t.after(data.close);
  await reconcileGroups(data.db,session,[{id:one,name:'Xeption Dev'}]);await authorize(data.db,one);
  let calls=0,release=()=>{},started=()=>{};
  const gate=new Promise<void>(r=>{release=r;}),ready=new Promise<void>(r=>{started=r;});
  const http=(async()=>{calls++;started();await gate;return new Response('{}',{status:201});}) as typeof fetch;
  const first=dispatchXeptionWhatsApp(request(),settings(data.db),http);
  await ready;
  const concurrent=await dispatchXeptionWhatsApp(request(),settings(data.db),http);
  assert.equal(concurrent.status,503);release();assert.equal((await first).status,202);
  assert.equal(calls,1);
});

test('fallback is explicit, only when no project candidate exists, and never on DB failure',async t=>{
  const data=routingDb();t.after(data.close);
  await reconcileGroups(data.db,session,[{id:one,name:'Atelier Maitre'}]);
  const sent:string[]=[];
  const http=(async(_url:RequestInfo|URL,init?:RequestInit)=>{
    sent.push(JSON.parse(String(init?.body)).chatId);return new Response('{}',{status:201});
  }) as typeof fetch;
  assert.equal((await dispatchXeptionWhatsApp(request(),{...settings(data.db),WAHA_FALLBACK_PROJECTS:''},http)).status,503);
  assert.equal((await dispatchXeptionWhatsApp(request(),settings(data.db),http)).status,202);
  assert.deepEqual(sent,['999999@g.us']);
  await reconcileGroups(data.db,session,[{id:one,name:'Xeption Clients'}]);
  assert.equal((await dispatchXeptionWhatsApp(request({...event,id:'event222'}),settings(data.db),http)).status,503);
  assert.deepEqual(sent,['999999@g.us']);
  const broken={prepare(){throw Error('db offline');},async batch(){throw Error('db offline');}};
  assert.equal((await dispatchXeptionWhatsApp(request(),settings(broken),http)).status,503);
  assert.deepEqual(sent,['999999@g.us']);
});

test('discovery outage retains approved routes; departures and revoked groups do not get fallback',async t=>{
  const data=routingDb();t.after(data.close);
  await reconcileGroups(data.db,session,[{id:one,name:'Xeption Dev'}],0);await authorize(data.db,one);
  let messages=0;
  const http=(async(_url:RequestInfo|URL,init?:RequestInit)=>{
    if(!init?.body)return new Response('forbidden',{status:403});
    messages++;assert.equal(JSON.parse(String(init.body)).chatId,one);
    return new Response('{}',{status:201});
  }) as typeof fetch;
  assert.equal((await dispatchXeptionWhatsApp(request(),settings(data.db),http)).status,202);
  await authorize(data.db,one,false);
  assert.equal((await dispatchXeptionWhatsApp(request({...event,id:'event222'}),settings(data.db),http)).status,503);
  assert.equal(messages,1);
  assert.equal((await dispatchXeptionWhatsApp(request(),{...settings(undefined),WAHA_ROUTING_REQUIRED:'true'},http)).status,503);
});
