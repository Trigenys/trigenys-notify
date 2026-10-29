import assert from 'node:assert/strict';
import test from 'node:test';
import {dispatchEmail,type EmailEnv} from '../../src/core/email-dispatch.js';
import {claimEmail,finishEmail,cleanupEmailReceipts} from '../../src/core/email-receipts.js';
import type {EmailSender,SmtpMessage} from '../../src/core/email-contracts.js';
import {routingDb} from '../support/notify-db.js';

const key='fixture-key-'.repeat(6),now=Date.now();
function event(){return {version:1,project:'commerce-factory',id:'a'.repeat(64),occurredAt:new Date(now).toISOString(),expiresAt:new Date(now+300000).toISOString(),recipient:'merchant@example.com',message:{subject:'Votre lien de connexion',html:'<a href="https://auth.example/verify?token=fixture-only">Me connecter</a>',text:'https://auth.example/verify?token=fixture-only'}};}
function fixture(){
  const database=routingDb('0004'),sent:SmtpMessage[]=[];
  const env:EmailEnv={EMAIL_DISPATCH_ENABLED:'true',EMAIL_COMMERCE_FACTORY_INGEST_KEY:key,
    EMAIL_PROJECTS_JSON:JSON.stringify({'commerce-factory':{enabled:true,from:'Commerce Factory <commercefactory@trigenys.com>'}}),
    SMTP_USER:'primary@example.com',SMTP_PASSWORD:' meaningful spaces ',NOTIFY_DB:database.db};
  const sender:EmailSender=async(settings,message)=>{assert.equal(settings.password,' meaningful spaces ');assert.equal(settings.host,'mail.spacemail.com');assert.equal(settings.port,465);sent.push(message);return {accepted:true};};
  return {...database,env,sent,sender,async post(value:unknown=event(),overrides:Partial<EmailEnv>={},send:EmailSender=sender,auth=key,pathProject='commerce-factory'){
    return dispatchEmail(new Request('https://notify.example/v1/dispatch/'+pathProject+'/email',{method:'POST',headers:{'x-notify-auth':auth,'content-type':'application/json'},body:JSON.stringify(value)}),{...env,...overrides},send,now);
  }};
}

test('email dispatch requires a scoped key, project opt-in, TLS settings and existing storage',async()=>{
  const f=fixture();try{
    assert.equal((await f.post(event(),{},f.sender,'wrong')).status,401);
    for(const settings of [{EMAIL_DISPATCH_ENABLED:'false'},{EMAIL_PROJECTS_JSON:'{}'},{NOTIFY_DB:undefined},{SMTP_PASSWORD:''},{SMTP_PORT:'25'},{EMAIL_PROJECTS_JSON:'invalid'}])assert.equal((await f.post(event(),settings)).status,503);
    assert.equal((await f.post(event(),{},f.sender,key,'xeption')).status,503);
    assert.equal((await f.post({...event(),project:'xeption'})).status,400);assert.equal(f.sent.length,0);
  }finally{f.close();}
});
test('accepted SMTP email has pinned sender, text/HTML and stable identity; retries survive a new handler',async()=>{
  const f=fixture();try{
    const r=await f.post();assert.equal(r.status,202);assert.deepEqual(await r.json(),{accepted:true,project:'commerce-factory',channel:'email',eventId:event().id});
    assert.equal((await f.post()).status,202);assert.equal(f.sent.length,1);
    assert.equal(f.sent[0].from,'Commerce Factory <commercefactory@trigenys.com>');assert.match(f.sent[0].messageId,/^<notify\.commerce-factory\.[a-f0-9]{64}@trigenys.com>$/);
    const row=f.sqlite.prepare('SELECT * FROM notify_email_deliveries').get()!;
    const stored=JSON.stringify(row);for(const value of ['merchant@example.com','fixture-only','<a href','meaningful spaces',key])assert.equal(stored.includes(value),false);
    assert.equal(row.state,'accepted');assert.equal(row.attempts,1);assert.match(String(row.payload_hash),/^[a-f0-9]{64}$/);
    assert.equal((await f.post({...event(),recipient:'other@example.com'})).status,409);assert.equal(f.sent.length,1);
  }finally{f.close();}
});
test('simultaneous requests claim once, while an in-flight or abandoned claim is never auto-replayed',async()=>{
  const f=fixture();try{
    let release!:()=>void,arrived!:()=>void;
    const started=new Promise<void>(r=>{arrived=r;}),hold=new Promise<void>(r=>{release=r;});
    const send:EmailSender=async(_settings,m)=>{f.sent.push(m);arrived();await hold;return {accepted:true};};
    const first=f.post(event(),{},send);await started;
    assert.equal((await f.post(event(),{},send)).status,503);release();assert.equal((await first).status,202);assert.equal(f.sent.length,1);
    const e={...event(),id:'b'.repeat(64)};
    const claim=await claimEmail(f.db,e.project,e.id,'c'.repeat(64),now+300000);assert.equal(claim.state,'claimed');
    assert.equal((await claimEmail(f.db,e.project,e.id,'c'.repeat(64),now+300000)).state,'blocked');
  }finally{f.close();}
});
test('confirmed rejection can retry at most three times; uncertain DATA acceptance never retries',async()=>{
  for(const safeToRetry of [true,false]){
    const f=fixture();let attempts=0;try{
      const send:EmailSender=async()=>{attempts++;return {accepted:false,safeToRetry};};
      for(let i=0;i<4;i++)assert.equal((await f.post(event(),{},send)).status,503);
      assert.equal(attempts,safeToRetry?3:1);
      assert.equal(f.sqlite.prepare('SELECT state FROM notify_email_deliveries').get()!.state,safeToRetry?'retry':'uncertain');
    }finally{f.close();}
  }
});
test('unexpected transport errors and a lost receipt write cannot trigger duplicate sends',async()=>{
  const f=fixture();try{
    let count=0;const send:EmailSender=async()=>{count++;throw Error('credentials must stay private');};
    const r=await f.post(event(),{},send);assert.equal(r.status,503);assert.equal((await r.text()).includes('credentials'),false);
    assert.equal((await f.post(event(),{},send)).status,503);assert.equal(count,1);
    const e={...event(),id:'d'.repeat(64)};
    const claim=await claimEmail(f.db,e.project,e.id,'e'.repeat(64),now+300000);
    assert.equal(claim.state,'claimed');
    await assert.rejects(finishEmail(f.db,e.project,e.id,'wrong-token','accepted'));
    assert.equal((await claimEmail(f.db,e.project,e.id,'e'.repeat(64),now+300000)).state,'blocked');
    f.sqlite.exec("CREATE TRIGGER fail_email_receipt BEFORE UPDATE OF state ON notify_email_deliveries WHEN NEW.state='accepted' BEGIN SELECT RAISE(FAIL,'fixture receipt failure'); END");
    const accepted:EmailSender=async()=>{count++;return {accepted:true};};
    const lost={...event(),id:'f'.repeat(64)};
    assert.equal((await f.post(lost,{},accepted)).status,503);
    assert.equal((await f.post(lost,{},accepted)).status,503);assert.equal(count,2);
  }finally{f.close();}
});
test('invalid, expired, future, forged sender and excessive payloads are rejected without sending',async()=>{
  const f=fixture();try{
    for(const e of [{...event(),recipient:'one@example.com,two@example.com'},{...event(),from:'Other <other@example.com>'},{...event(),occurredAt:new Date(now+61000).toISOString()},{...event(),expiresAt:new Date(now-1).toISOString()},{...event(),message:{...event().message,subject:'one\r\nBCC:other@example.com'}}])assert.equal((await f.post(e)).status,400);
    assert.equal((await f.post({...event(),message:{...event().message,html:'a'.repeat(66000)}})).status,413);assert.equal(f.sent.length,0);
    const before=f.sqlite.prepare('SELECT count(*) n FROM notify_email_deliveries').get()!.n;assert.equal(before,0);
  }finally{f.close();}
});
test('bounded cleanup removes only expired email receipts and leaves group routes intact',async()=>{
  const f=fixture();try{
    await f.post();await cleanupEmailReceipts(f.db);
    assert.equal(f.sqlite.prepare('SELECT count(*) n FROM notify_email_deliveries').get()!.n,1);
    f.sqlite.exec('UPDATE notify_email_deliveries SET expires_at_ms=0');await cleanupEmailReceipts(f.db);
    assert.equal(f.sqlite.prepare('SELECT count(*) n FROM notify_email_deliveries').get()!.n,0);
    assert.ok(f.sqlite.prepare("SELECT name FROM sqlite_master WHERE name='notify_whatsapp_routes'").get());
  }finally{f.close();}
});
