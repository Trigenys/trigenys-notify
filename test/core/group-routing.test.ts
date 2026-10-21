import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {authenticateWebhook,handleGroupWebhook,handleGroupAdmin,resolveProjectGroups,
  reconcileGroups,syncWahaGroups,type GroupEnv} from '../../src/core/group-routing.js';
import {normalizeWahaGroups,WahaGroupDirectory,matchesProject} from '../../src/core/waha-groups.js';
import {routingDb} from '../support/notify-db.js';

const key='private-hmac-secret-with-at-least-32-characters';
const adminKey='private-admin-key-with-at-least-32-characters';
const id='120363123456789@g.us',second='120363987654321@g.us',session='trigenys-test';
const root='https://notify.example.com/v1/whatsapp';
const env=(db:GroupEnv['NOTIFY_DB']):GroupEnv=>({NOTIFY_DB:db,
  WAHA_SESSION:session,WAHA_WEBHOOK_HMAC_KEY:key,NOTIFY_ADMIN_KEY:adminKey,
  WAHA_BASE_URL:'https://notify.trigenys.com',WAHA_API_KEY:'K'.repeat(64)});
async function eventRequest(event:string,signWith=key){
  const body=JSON.stringify({event,session,payload:{group:{id,subject:'Xeption app test'}}});
  const cryptoKey=await crypto.subtle.importKey('raw',new TextEncoder().encode(signWith),
    {name:'HMAC',hash:'SHA-512'},false,['sign']);
  const signature=Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',cryptoKey,new TextEncoder().encode(body))))
    .map(x=>x.toString(16).padStart(2,'0')).join('');
  return new Request(root+'/groups/webhook',{method:'POST',body,headers:{
    'content-type':'application/json','x-webhook-hmac':signature,
    'x-webhook-hmac-algorithm':'sha512','x-webhook-timestamp':String(Date.now())}});
}
const approve=(groupId=id,enabled=true)=>new Request(root+'/routes',{method:'POST',
  headers:{'x-notify-admin-key':adminKey},body:JSON.stringify({project:'xeption',session,groupId,enabled})});

test('signed discovery does not approve; stale timestamps and other sessions fail',async t=>{
  const data=routingDb();t.after(data.close);const config=env(data.db);
  assert.equal((await handleGroupWebhook(await eventRequest('group.v2.join','wrong-but-long-enough-hmac-key'),config)).status,401);
  const valid=await eventRequest('group.v2.join');
  assert.equal(await authenticateWebhook(valid,key,await valid.clone().text()),true);
  assert.equal((await handleGroupWebhook(valid,config)).status,200);
  assert.deepEqual(await resolveProjectGroups(data.db,'xeption'),[]);
  const stale=await eventRequest('group.v2.join');
  stale.headers.set('x-webhook-timestamp',String(Date.now()-900000));
  assert.equal((await handleGroupWebhook(stale,config)).status,401);
  assert.equal((await handleGroupWebhook(await eventRequest('group.v2.join'),{...config,WAHA_SESSION:'another'})).status,400);
  assert.equal((await handleGroupWebhook(await eventRequest('group.v2.join'),{})).status,503);
});

test('multiple approvals coexist, revocation affects one group, departure disables routes',async t=>{
  const data=routingDb();t.after(data.close);const config=env(data.db);
  await reconcileGroups(data.db,session,[{id,name:'Xeption Dev'},{id:second,name:'Xeption Team'}]);
  assert.equal((await handleGroupAdmin(new Request(root+'/routes',{method:'POST',body:'{}'}),config)).status,401);
  for(const groupId of [id,second])assert.equal((await handleGroupAdmin(approve(groupId),config)).status,200);
  await handleGroupAdmin(approve(),config);
  assert.equal((await resolveProjectGroups(data.db,'xeption')).length,2);
  assert.deepEqual(await resolveProjectGroups(data.db,'atelier-maitre'),[]);
  await handleGroupAdmin(approve(id,false),config);
  assert.deepEqual(await resolveProjectGroups(data.db,'xeption'),[{session,groupId:second}]);
  await handleGroupAdmin(approve(),config);
  await handleGroupWebhook(await eventRequest('group.v2.leave'),config);
  assert.deepEqual(await resolveProjectGroups(data.db,'xeption'),[{session,groupId:second}]);
  await handleGroupWebhook(await eventRequest('group.v2.join'),config);
  assert.equal((await resolveProjectGroups(data.db,'xeption')).length,1);
});

test('migration preserves approvals and permits additional groups',async t=>{
  const data=routingDb('0001');t.after(data.close);
  data.sqlite.exec(`INSERT INTO notify_whatsapp_groups VALUES('${session}','${id}','Xeption','available',0);
    INSERT INTO notify_whatsapp_routes VALUES('xeption','${session}','${id}',1,'2026-10-20');`);
  data.sqlite.exec(readFileSync('backend/migrations/0002_multigroup_routes.sql','utf8'));
  assert.deepEqual(await resolveProjectGroups(data.db,'xeption'),[{session,groupId:id}]);
});

test('initial staging migration selects confirmed Xeption group and stays revoked on rerun',async t=>{
  const data=routingDb('0003');t.after(data.close);
  const groupId='120363432964279423@g.us';
  assert.deepEqual(await resolveProjectGroups(data.db,'xeption'),[{session,groupId}]);
  await handleGroupAdmin(approve(groupId,false),env(data.db));
  data.sqlite.exec(readFileSync('backend/migrations/0003_staging_xeption_route.sql','utf8'));
  assert.deepEqual(await resolveProjectGroups(data.db,'xeption'),[]);
});

test('NOWEB keyed objects and wrapped lists normalize without copying participants',()=>{
  assert.deepEqual(normalizeWahaGroups({[id]:{subject:'Xeption app test',participants:['private']}}),[{id,name:'Xeption app test'}]);
  for(const field of ['data','groups','items','results'])
    assert.deepEqual(normalizeWahaGroups({[field]:[{id,name:'Xeption Dev'}]}),[{id,name:'Xeption Dev'}]);
  assert.throws(()=>normalizeWahaGroups({[id]:{id:second,subject:'wrong'}}));
  assert.equal(matchesProject('XÉPTION app test','xeption'),true);
  assert.equal(matchesProject('nonxeption','xeption'),false);
  assert.equal(matchesProject('Commerce Factory Dev','commerce-factory'),true);
});

test('discovery paginates and rejects incomplete snapshots without disabling approvals',async t=>{
  const ids=Array.from({length:101},(_,i)=>String(12000000+i)+'@g.us');
  const offsets:number[]=[];
  const http=(async(url:RequestInfo|URL)=>{
    if(String(url).endsWith('/count'))return Response.json({count:101});
    const offset=Number(new URL(String(url)).searchParams.get('offset'));offsets.push(offset);
    return Response.json(ids.slice(offset,offset+100).map(id=>({id,subject:'Xeption Dev'})));
  }) as typeof fetch;
  const list=await new WahaGroupDirectory({baseUrl:'https://notify.trigenys.com',apiKey:'K'.repeat(64),session},http).list();
  assert.equal(list.length,101);assert.deepEqual(offsets,[0,100]);
  const data=routingDb();t.after(data.close);const config=env(data.db);
  await reconcileGroups(data.db,session,[{id,name:'Xeption Dev'}],0);
  await handleGroupAdmin(approve(),config);
  const incomplete=(async(url:RequestInfo|URL)=>Response.json(String(url).endsWith('/count')?{count:2}:[{id,subject:'Xeption Dev'}])) as typeof fetch;
  await assert.rejects(syncWahaGroups(config,incomplete,true));
  assert.equal((await resolveProjectGroups(data.db,'xeption')).length,1);
});

test('polling discovers candidates, never approves, and does not revive disabled routes',async t=>{
  const data=routingDb();t.after(data.close);const config=env(data.db);
  const http=(async(url:RequestInfo|URL)=>Response.json(String(url).endsWith('/count')?{count:2}:{
    [id]:{subject:'Xeption Dev'},[second]:{subject:'Xeption Clients'}})) as typeof fetch;
  assert.equal(await syncWahaGroups(config,http,true),2);
  assert.deepEqual(await resolveProjectGroups(data.db,'xeption'),[]);
  const response=await handleGroupAdmin(new Request(root+'/groups',{headers:{'x-notify-admin-key':adminKey}}),config);
  const body=await response.json() as {groups:{suggestedProjects:string[]}[]};
  assert.equal(body.groups.length,2);assert.deepEqual(body.groups[0].suggestedProjects,['xeption']);
  await handleGroupAdmin(approve(),config);
  await handleGroupWebhook(await eventRequest('group.v2.leave'),config);
  await syncWahaGroups(config,http,true);
  assert.deepEqual(await resolveProjectGroups(data.db,'xeption'),[]);
});

test('group discovery does not forward the provider key through redirects',async()=>{
  let calls=0;
  const http=(async(_url:RequestInfo|URL,init?:RequestInit)=>{
    calls++;assert.equal(init?.redirect,'manual');
    return new Response('',{status:302,headers:{location:'https://other.example/'}});
  }) as typeof fetch;
  await assert.rejects(new WahaGroupDirectory({baseUrl:'https://notify.trigenys.com',
    apiKey:'K'.repeat(64),session},http).list());
  assert.equal(calls,1);
});
