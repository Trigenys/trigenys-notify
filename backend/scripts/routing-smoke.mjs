import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {readFile,readdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';

const session='trigenys-test',key='I'.repeat(48),admin='A'.repeat(48);
const xeption='120363432964279423@g.us',extra='120363000000001@g.us',studio='120363000000777@g.us';
const received=[];
const mf=new Miniflare(convertV4MiniflareOptions({
  modulesRoot:resolve('.wrangler-dry-run'),
  modules:[{type:'ESModule',path:resolve('.wrangler-dry-run/index.js')},
    ...(await readdir('.wrangler-dry-run')).filter(f=>f.endsWith('.html'))
      .map(f=>({type:'Text',path:resolve('.wrangler-dry-run',f)}))],
  compatibilityDate:'2026-10-20',compatibilityFlags:['nodejs_compat'],
  d1Databases:{NOTIFY_DB:'routing-smoke'},
  bindings:{EMAIL_DISPATCH_ENABLED:'true',EMAIL_COMMERCE_FACTORY_INGEST_KEY:key,
    EMAIL_PROJECTS_JSON:JSON.stringify({'commerce-factory':{enabled:true,from:'Commerce Factory <commercefactory@trigenys.com>'}}),
    SMTP_HOST:'smtp.example.invalid',SMTP_USER:'fixture@example.com',SMTP_PASSWORD:'fixture-not-a-real-secret',
    WAHA_DISPATCH_ENABLED:'true',WAHA_ROUTING_REQUIRED:'true',
    XEPTION_NOTIFY_INGEST_KEY:key,NOTIFY_ADMIN_KEY:admin,
    WAHA_BASE_URL:'https://notify.example.com',WAHA_API_KEY:'test-waha-api-key',
    WAHA_SESSION:session,WAHA_STAFF_GROUP_ID:'999999@g.us',WAHA_FALLBACK_PROJECTS:'xeption',
    WHATSAPP_TRIGENYS_STUDIO_INGEST_KEY:key,
    WHATSAPP_PROJECTS_JSON:JSON.stringify({'trigenys-studio':{enabled:true,groups:[studio],allowedLinkOrigins:['https://studio.example.com']}})},
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
  const notice={version:1,project:'trigenys-studio',id:'d'.repeat(64),occurredAt:new Date().toISOString(),
    expiresAt:new Date(Date.now()+300000).toISOString(),
    message:{text:'Fixture only',link:'https://studio.example.com/tasks/1',linkLabel:'Ouvrir'}};
  const notify=()=>mf.dispatchFetch('http://localhost/v1/dispatch/trigenys-studio/whatsapp',{
    method:'POST',headers:{'x-notify-auth':key,'content-type':'application/json'},body:JSON.stringify(notice)});
  const generic=await notify();assert.equal(generic.status,202,await generic.text());
  assert.equal((await notify()).status,202);
  const studioSends=received.filter(r=>r.chatId===studio);
  assert.equal(studioSends.length,1);assert.equal(received.length,3);
  assert.equal(studioSends[0].text,['Fixture only','','🔗 Ouvrir','https://studio.example.com/tasks/1'].join('\n'));
  console.log('Worker generic WhatsApp route passed: declared group only, idempotent retry, zero real messages.');
  const email={version:1,project:'commerce-factory',id:'a'.repeat(64),occurredAt:new Date().toISOString(),
    expiresAt:new Date(Date.now()+300000).toISOString(),recipient:'merchant@example.com',
    message:{subject:'Fixture only',html:'<p>Fixture only</p>',text:'Fixture only'}};
  const sendEmail=(auth)=>mf.dispatchFetch('http://localhost/v1/dispatch/commerce-factory/email',{
    method:'POST',headers:{'x-notify-auth':auth,'content-type':'application/json'},body:JSON.stringify(email)});
  assert.equal((await sendEmail('wrong')).status,401);
  const unavailable=await sendEmail(key);assert.equal(unavailable.status,503,await unavailable.text());
  const emailReceipt=await db.prepare('SELECT state FROM notify_email_deliveries').first();
  assert.equal(emailReceipt.state,'retry');
  console.log('Worker SMTP adapter + D1 failure path passed: scoped auth, unreachable test host, zero real email.');
  console.log('Worker + D1 smoke passed: two approved destinations, safe retry, zero real messages.');
}finally{await mf.dispose();}
