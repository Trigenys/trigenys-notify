import test from 'node:test';
import assert from 'node:assert/strict';
import {wahaMessageKeyId} from '../../src/core/waha-message-id.js';
import {dispatchXeptionWhatsApp,type DispatchEnv} from '../../src/core/dispatch.js';
import {reconcileGroups,handleGroupAdmin} from '../../src/core/group-routing.js';
import {routingDb} from '../support/notify-db.js';

const KEY='3EB0A1B2C3D4E5F60718';

test('extracts only the message key from WAHA id shapes',()=>{
  assert.equal(wahaMessageKeyId({id:`true_120363000000000000@g.us_${KEY}`}),KEY);
  assert.equal(wahaMessageKeyId(`false_120363000000000000@g.us_${KEY}_237600000000@c.us`),KEY);
  assert.equal(wahaMessageKeyId({id:{_serialized:`true_120363000000000000@g.us_${KEY}`}}),KEY);
  assert.equal(wahaMessageKeyId({key:{id:KEY,remoteJid:'120363000000000000@g.us'}}),KEY);
  assert.equal(wahaMessageKeyId({id:KEY}),KEY);
  for(const bad of [undefined,null,'',{},'short','true_x@g.us_bad!key',{id:'a b c d e f g h'},{key:{id:42}}])
    assert.equal(wahaMessageKeyId(bad),undefined);
});

const session='trigenys-test',group='120001@g.us',admin='A'.repeat(48),key='I'.repeat(48);
const event={version:1,project:'xeption',id:'event333',type:'inventory.stock_low',
  occurredAt:'2026-11-16T10:00:00Z',priority:'high',resource:{kind:'inventory',id:'part001'},
  audience:'staff',actionUrl:'https://www.xeptionetwork.shop/admin/inventory'};
const request=()=>new Request('https://notify.example/v1/dispatch/xeption/whatsapp',{
  method:'POST',headers:{'content-type':'application/json','x-notify-auth':key},body:JSON.stringify(event)});
const settings=(db:DispatchEnv['NOTIFY_DB']):DispatchEnv=>({NOTIFY_DB:db,WAHA_DISPATCH_ENABLED:'true',
  XEPTION_NOTIFY_INGEST_KEY:key,WAHA_BASE_URL:'https://notify.trigenys.com',WAHA_API_KEY:'K'.repeat(64),
  WAHA_SESSION:session,WAHA_STAFF_GROUP_ID:'999999@g.us',WAHA_FALLBACK_PROJECTS:'xeption'});
async function approve(db:NonNullable<DispatchEnv['NOTIFY_DB']>){
  await reconcileGroups(db,session,[{id:group,name:'Xeption Dev'}]);
  const r=await handleGroupAdmin(new Request('https://notify.example/v1/whatsapp/routes',{
    method:'POST',headers:{'x-notify-admin-key':admin},body:JSON.stringify({project:'xeption',session,groupId:group,enabled:true})
  }),{NOTIFY_DB:db,NOTIFY_ADMIN_KEY:admin,WAHA_SESSION:session});
  assert.equal(r.status,200);
}
const provider=(body:string)=>(async()=>new Response(body,{status:201})) as unknown as typeof fetch;

test('an accepted group delivery stores the provider message key on its receipt',async t=>{
  const data=routingDb('0006');t.after(data.close);await approve(data.db);
  const res=await dispatchXeptionWhatsApp(request(),settings(data.db),
    provider(JSON.stringify({id:`true_${group}_${KEY}`,body:'ignored'})));
  assert.equal(res.status,202);
  const row=data.sqlite.prepare('SELECT state,provider_message_id FROM notify_whatsapp_receipts').get() as Record<string,unknown>;
  assert.deepEqual({...row},{state:'accepted',provider_message_id:KEY});
});

test('no id or an unparsable body still accepts the delivery',async t=>{
  const data=routingDb('0006');t.after(data.close);await approve(data.db);
  assert.equal((await dispatchXeptionWhatsApp(request(),settings(data.db),provider('not json'))).status,202);
  const row=data.sqlite.prepare('SELECT state,provider_message_id FROM notify_whatsapp_receipts').get() as Record<string,unknown>;
  assert.deepEqual({...row},{state:'accepted',provider_message_id:null});
});

test('a database without migration 0006 keeps dispatching and recording receipts',async t=>{
  const data=routingDb('0005');t.after(data.close);await approve(data.db);
  const res=await dispatchXeptionWhatsApp(request(),settings(data.db),provider(JSON.stringify({id:KEY})));
  assert.equal(res.status,202);
  const row=data.sqlite.prepare('SELECT state FROM notify_whatsapp_receipts').get() as Record<string,unknown>;
  assert.equal(row.state,'accepted');
});
