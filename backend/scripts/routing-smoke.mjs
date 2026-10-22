import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {readFile,readdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';

const session='trigenys-test',key='I'.repeat(48),admin='A'.repeat(48);
const xeption='120363432964279423@g.us',extra='120363000000001@g.us';
const received=[];
const mf=new Miniflare(convertV4MiniflareOptions({
  modulesRoot:resolve('.wrangler-dry-run'),
  modules:[{type:'ESModule',path:resolve('.wrangler-dry-run/index.js')},
    ...(await readdir('.wrangler-dry-run')).filter(f=>f.endsWith('.html'))
      .map(f=>({type:'Text',path:resolve('.wrangler-dry-run',f)}))],
  compatibilityDate:'2026-10-20',compatibilityFlags:['nodejs_compat'],
  d1Databases:{NOTIFY_DB:'routing-smoke'},
  bindings:{WAHA_DISPATCH_ENABLED:'true',WAHA_ROUTING_REQUIRED:'true',
    XEPTION_NOTIFY_INGEST_KEY:key,NOTIFY_ADMIN_KEY:admin,
    WAHA_BASE_URL:'https://notify.example.com',WAHA_API_KEY:'test-waha-api-key',
    WAHA_SESSION:session,WAHA_STAFF_GROUP_ID:'999999@g.us',WAHA_FALLBACK_PROJECTS:'xeption'},
  outboundService:async(request)=>{
    const url=new URL(request.url);
    if(url.pathname.endsWith('/count'))return Response.json({count:2});
    if(request.method==='GET')return Response.json({
      [xeption]:{subject:'Xeption app test'},[extra]:{subject:'Xeption Dev'}});
    assert.equal(url.pathname,'/api/sendText');
    received.push(await request.json());return Response.json({accepted:true},{status:201});
  }
}));
try{
  const db=await mf.getD1Database('NOTIFY_DB');
  for(const file of (await readdir('migrations')).filter(f=>f.endsWith('.sql')).sort()){
    const statements=(await readFile('migrations/'+file,'utf8')).replace(/--[^\n]*/g,'')
      .split(';').map(s=>s.trim()).filter(Boolean);
    await db.batch(statements.map(s=>db.prepare(s)));
  }
  const health=await (await mf.dispatchFetch('http://localhost/health')).json();
  assert.equal(health.whatsappRegistry,'d1');
  assert.equal((await mf.dispatchFetch('http://localhost/v1/whatsapp/groups')).status,401);
  const adminFetch=(path,body)=>mf.dispatchFetch('http://localhost/v1/whatsapp/'+path,{
    method:'POST',headers:{'x-notify-admin-key':admin,'content-type':'application/json'},body:JSON.stringify(body)});
  const synced=await adminFetch('groups/sync',{});
  assert.equal(synced.status,200,await synced.text());
  const approve=await adminFetch('routes',{project:'xeption',session,groupId:extra});
  assert.equal(approve.status,200);
  const event={version:1,project:'xeption',id:'worker-smoke-event',type:'inventory.stock_low',
    occurredAt:'2026-10-21T10:00:00Z',priority:'high',audience:'staff',
    resource:{kind:'inventory',id:'sample-product'},actionUrl:'https://www.xeptionetwork.shop/admin/inventory',
    facts:{subject:'Dell XPS 14 9440 (2023)',stockRemaining:2,actor:'Équipe test'}};
  const dispatch=()=>mf.dispatchFetch('http://localhost/v1/dispatch/xeption/whatsapp',{
    method:'POST',headers:{'x-notify-auth':key,'content-type':'application/json'},body:JSON.stringify(event)});
  const first=await dispatch();assert.equal(first.status,202,await first.text());
  const retry=await dispatch();assert.equal(retry.status,202,await retry.text());
  assert.deepEqual(received.map(r=>r.chatId).sort(),[xeption,extra].sort());
  for(const message of received){
    assert.match(message.text,/Dell XPS 14 9440/);
    assert.match(message.text,/Stock restant : 2 unités/);
    assert.match(message.text,/Par : Équipe test/);
  }
  const receipts=await db.prepare("SELECT COUNT(*) AS n FROM notify_whatsapp_receipts WHERE state='accepted'").first();
  assert.equal(receipts.n,2);
  console.log('Worker + D1 smoke passed: two approved destinations, safe retry, zero real messages.');
}finally{await mf.dispose();}
