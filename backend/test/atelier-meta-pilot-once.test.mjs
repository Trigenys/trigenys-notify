import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildPilotPayload,pilotEndpoint,runPilotOnce} from '../scripts/atelier-meta-pilot-once.mjs';

const id='pilot-123e4567-e89b-12d3-a456-426614174000';
const env={
  ATELIER_NOTIFY_INGEST_KEY:'k'.repeat(64),
  ATELIER_META_PILOT_TO:'+237690000001',
  ATELIER_META_PILOT_CONFIRM:'I_AUTHORIZE_ONE_PILOT_WHATSAPP'
};
async function marker(){return join(await mkdtemp(join(tmpdir(),'notify-pilot-')),'attempt.json');}

test('fixed approved vehicle-ready FR template with ordered variables',()=>{
  assert.deepEqual(buildPilotPayload(env.ATELIER_META_PILOT_TO,id),{
    eventId:id,eventType:'VEHICLE_READY',to:env.ATELIER_META_PILOT_TO,
    templateName:'am_vehicle_ready_v1',language:'fr',
    variables:['Cliente de test','LT TEST 001','Atelier Maître']
  });
  assert.equal(pilotEndpoint(),
    'https://trigenys-notify-staging-api.lawrynnjennifer.workers.dev/v1/dispatch/atelier/whatsapp');
  assert.throws(()=>buildPilotPayload('not a phone',id),/PILOT_RECIPIENT_INVALID/);
});

test('refuse missing confirmation or key before network',async()=>{
  const file=await marker();let calls=0;
  const http=async()=>{calls++;throw Error('network should not be reached');};
  await assert.rejects(runPilotOnce({
    env:{...env,ATELIER_META_PILOT_CONFIRM:''},http,markerPath:file,eventId:id
  }),/PILOT_CONFIRMATION_REQUIRED/);
  await assert.rejects(runPilotOnce({
    env:{...env,ATELIER_NOTIFY_INGEST_KEY:'short'},http,markerPath:file,eventId:id
  }),/INGEST_KEY_REQUIRED/);
  assert.equal(calls,0);
});

test('one HTTP attempt and durable local marker written before dispatch',async()=>{
  const file=await marker();let calls=0;
  const http=async(url,init)=>{
    calls++;
    assert.equal(url,pilotEndpoint());
    assert.equal(init.headers['x-notify-auth'],env.ATELIER_NOTIFY_INGEST_KEY);
    assert.deepEqual(JSON.parse(init.body),buildPilotPayload(env.ATELIER_META_PILOT_TO,id));
    assert.equal(JSON.parse(await readFile(file,'utf8')).state,'attempted');
    return new Response(JSON.stringify({accepted:true,providerMessageId:'wamid.TEST'}),{status:202});
  };
  assert.deepEqual(await runPilotOnce({env,http,markerPath:file,eventId:id}),
    {status:'META_ACCEPTED_NOT_DELIVERED',providerMessageId:'wamid.TEST'});
  await assert.rejects(runPilotOnce({env,http,markerPath:file,eventId:id}),
    /PILOT_ALREADY_ATTEMPTED_NO_RETRY/);
  assert.equal(calls,1);
});

test('ambiguous network outcome is never auto-retried',async()=>{
  const file=await marker();let calls=0;
  const http=async()=>{calls++;throw Error('private provider detail');};
  await assert.rejects(runPilotOnce({env,http,markerPath:file,eventId:id}),
    /PILOT_UNKNOWN_OUTCOME_NO_RETRY/);
  await assert.rejects(runPilotOnce({env,http,markerPath:file,eventId:id}),
    /PILOT_ALREADY_ATTEMPTED_NO_RETRY/);
  assert.equal(calls,1);
});

test('disabled channel returns a fixed error and no further attempt',async()=>{
  const file=await marker();let calls=0;
  const http=async()=>{
    calls++;return new Response(JSON.stringify({error:'CHANNEL_DISABLED'}),{status:503});
  };
  await assert.rejects(runPilotOnce({env,http,markerPath:file,eventId:id}),
    /PILOT_NOT_ACCEPTED_HTTP_503_CHANNEL_DISABLED_NO_RETRY/);
  assert.equal(calls,1);
});
