import test from 'node:test';
import assert from 'node:assert/strict';
import {routingDb} from '../support/notify-db.js';
import {watchdogDecision,runWahaWatchdog,formatDuration,readSessionStatus,
  WATCHDOG_TICK_MS,WATCHDOG_GRACE_MS,type WatchdogEnv} from '../../src/core/waha-watchdog.js';

const session='trigenys-test',apiKey='K'.repeat(64),token='123456:'+'A'.repeat(35),chatId='987654321';
const MIN=60_000,HOUR=60*MIN;
const env=(db:WatchdogEnv['NOTIFY_DB'],telegram=true):WatchdogEnv=>({NOTIFY_DB:db,WAHA_SESSION:session,
  WAHA_BASE_URL:'https://notify.trigenys.com',WAHA_API_KEY:apiKey,
  ...(telegram?{TELEGRAM_BOT_TOKEN:token,OPS_TELEGRAM_CHAT_ID:chatId}:{})});

/** WAHA mock: groups listing succeeds only when the session works; Telegram calls are captured. */
function provider(status:string,sent:{chat_id:string;text:string}[]){
  return (async(url:RequestInfo|URL,init?:RequestInit)=>{
    const href=String(url);
    if(href.startsWith('https://api.telegram.org/')){
      sent.push(JSON.parse(String(init?.body)));return Response.json({ok:true});
    }
    if(href.includes('/api/sessions/'))return Response.json({name:session,status});
    if(status!=='WORKING')return Response.json({error:'session status is not as expected'},{status:422});
    return Response.json(href.endsWith('/count')?{count:1}:[{id:'120363123456789@g.us',subject:'Xeption'}]);
  }) as typeof fetch;
}
async function seed(db:NonNullable<WatchdogEnv['NOTIFY_DB']>,lastSyncedMs:number){
  await db.prepare(`INSERT INTO notify_whatsapp_discovery(session,last_synced_ms) VALUES(?1,?2)`)
    .bind(session,lastSyncedMs).run();
}

test('an outage alerts once after the grace period, then every six hours, then on recovery',()=>{
  const down:number[]=[];
  for(let now=WATCHDOG_TICK_MS;now<=13*HOUR;now+=WATCHDOG_TICK_MS){
    const alert=watchdogDecision({healthy:false,lastHealthyMs:0,now});
    if(alert)down.push(now);
  }
  assert.deepEqual(down,[10*MIN,6*HOUR+10*MIN,12*HOUR+10*MIN]);
  assert.deepEqual(watchdogDecision({healthy:true,lastHealthyMs:0,now:3*HOUR}),{kind:'recovered',outageMs:3*HOUR});
  // A short blip below the grace period stays silent in both directions.
  assert.equal(watchdogDecision({healthy:false,lastHealthyMs:0,now:5*MIN}),null);
  assert.equal(watchdogDecision({healthy:true,lastHealthyMs:0,now:5*MIN}),null);
  assert.equal(watchdogDecision({healthy:true,lastHealthyMs:null,now:HOUR}),null);
});

test('without a healthy baseline, reminders follow a fixed six-hour grid',()=>{
  const hits=[];
  for(let now=0;now<24*HOUR;now+=WATCHDOG_TICK_MS)
    if(watchdogDecision({healthy:false,lastHealthyMs:null,now}))hits.push(now/HOUR);
  assert.deepEqual(hits,[0,6,12,18]);
});

test('cron tick alerts the operator on Telegram, then announces recovery once',async t=>{
  const data=routingDb();t.after(data.close);
  const last=Date.now()-WATCHDOG_GRACE_MS-HOUR;await seed(data.db,last);
  const sent:{chat_id:string;text:string}[]=[];
  const alert=await runWahaWatchdog(env(data.db),last+WATCHDOG_GRACE_MS,provider('SCAN_QR_CODE',sent));
  assert.equal(alert?.kind,'down');
  assert.equal(sent.length,1);
  assert.equal(sent[0].chat_id,chatId);
  assert.match(sent[0].text,/WhatsApp en panne/);
  assert.match(sent[0].text,/déconnectée/);
  assert.match(sent[0].text,/QR code/);
  assert.match(sent[0].text,/Depuis : 10 min/);
  assert.doesNotMatch(sent[0].text,new RegExp(apiKey+'|notify\\.trigenys\\.com'));
  // Next tick, still down, inside the reminder window: silent.
  assert.equal(await runWahaWatchdog(env(data.db),last+WATCHDOG_GRACE_MS+WATCHDOG_TICK_MS,provider('SCAN_QR_CODE',sent)),null);
  assert.equal(sent.length,1);
  // Session back: one recovery message, and the sync refreshes the baseline.
  const now=Date.now();
  const recovered=await runWahaWatchdog(env(data.db),now,provider('WORKING',sent));
  assert.equal(recovered?.kind,'recovered');
  assert.equal(sent.length,2);
  assert.match(sent[1].text,/WhatsApp rétabli/);
  const row=await data.db.prepare(`SELECT last_synced_ms FROM notify_whatsapp_discovery WHERE session=?1`)
    .bind(session).first<{last_synced_ms:number}>();
  assert.ok(row&&row.last_synced_ms>=now-1000);
  assert.equal(await runWahaWatchdog(env(data.db),now+WATCHDOG_TICK_MS,provider('WORKING',sent)),null);
  assert.equal(sent.length,2);
});

test('missing Telegram configuration never throws and never calls Telegram',async t=>{
  const data=routingDb();t.after(data.close);
  const last=Date.now()-WATCHDOG_GRACE_MS-HOUR;await seed(data.db,last);
  const sent:{chat_id:string;text:string}[]=[];
  const alert=await runWahaWatchdog(env(data.db,false),last+WATCHDOG_GRACE_MS,provider('STOPPED',sent));
  assert.equal(alert?.kind,'down');
  assert.equal(sent.length,0);
});

test('session status maps transport failures and unknown payloads safely',async()=>{
  const config=env(undefined);
  assert.equal(await readSessionStatus(config,(async()=>{throw Error('down');}) as typeof fetch),'UNREACHABLE');
  assert.equal(await readSessionStatus(config,(async()=>new Response('',{status:502})) as typeof fetch),'UNREACHABLE');
  assert.equal(await readSessionStatus(config,(async()=>Response.json({status:'<script>'})) as typeof fetch),'UNKNOWN');
  assert.equal(await readSessionStatus(config,(async()=>Response.json({status:'FAILED'})) as typeof fetch),'FAILED');
  assert.equal(formatDuration(3*MIN),'3 min');
  assert.equal(formatDuration(2*HOUR+5*MIN),'2 h 05');
  assert.equal(formatDuration(8*24*HOUR+HOUR),'8 j 1 h');
});
