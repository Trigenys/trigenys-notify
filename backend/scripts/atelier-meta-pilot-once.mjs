/**
 * One-attempt Atelier Maître WhatsApp pilot through Trigenys Notify.
 * Reuses the existing Meta adapter; no new provider, model, secret or route.
 * The operator must explicitly opt in. Never retry ambiguous Meta outcomes.
 */
import {randomUUID} from 'node:crypto';
import {mkdir, open} from 'node:fs/promises';
import {homedir} from 'node:os';
import {dirname, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const ORIGIN='https://trigenys-notify-staging-api.lawrynnjennifer.workers.dev';
const PATH='/v1/dispatch/atelier/whatsapp';
const CONFIRM='I_AUTHORIZE_ONE_PILOT_WHATSAPP';
const DESTINATION_RE=/^\+[1-9]\d{7,14}$/;

export function buildPilotPayload(to,eventId){
  if(!DESTINATION_RE.test(to))throw new Error('PILOT_RECIPIENT_INVALID');
  if(!/^pilot-[0-9a-f-]{36}$/.test(eventId))throw new Error('PILOT_EVENT_ID_INVALID');
  return {
    eventId,eventType:'VEHICLE_READY',to,
    templateName:'am_vehicle_ready_v1',language:'fr',
    variables:['Cliente de test','LT TEST 001','Atelier Maître']
  };
}
export function pilotEndpoint(){return ORIGIN+PATH;}

export async function runPilotOnce({
  env=process.env,http=fetch,
  markerPath=resolve(homedir(),'.trigenys-notify','atelier-meta-pilot-attempt.json'),
  eventId='pilot-'+randomUUID()
}={}){
  if(env.ATELIER_META_PILOT_CONFIRM!==CONFIRM)throw new Error('PILOT_CONFIRMATION_REQUIRED');
  const ingestKey=env.ATELIER_NOTIFY_INGEST_KEY;
  if(typeof ingestKey!=='string'||ingestKey.length<32)throw new Error('INGEST_KEY_REQUIRED');
  const payload=buildPilotPayload(env.ATELIER_META_PILOT_TO||'',eventId);
  await mkdir(dirname(markerPath),{recursive:true,mode:0o700});
  let file;
  try{file=await open(markerPath,'wx',0o600);}
  catch(error){
    if(error?.code==='EEXIST')throw new Error('PILOT_ALREADY_ATTEMPTED_NO_RETRY');
    throw error;
  }
  try{
    // Lock before network call, even for an ambiguous response. Manual reset is required.
    await file.writeFile(JSON.stringify({eventId,attemptedAt:new Date().toISOString(),state:'attempted'}));
  }finally{await file.close();}
  let response;
  try{
    response=await http(pilotEndpoint(),{
      method:'POST',
      headers:{'content-type':'application/json','x-notify-auth':ingestKey},
      body:JSON.stringify(payload),
      signal:AbortSignal.timeout(12000)
    });
  }catch{throw new Error('PILOT_UNKNOWN_OUTCOME_NO_RETRY');}
  let data={};
  try{data=await response.json();}catch{/* no raw provider payload in logs */}
  if(response.status===202&&data.accepted===true&&typeof data.providerMessageId==='string')
    return {status:'META_ACCEPTED_NOT_DELIVERED',providerMessageId:data.providerMessageId};
  const allowedErrors=new Set([
    'CHANNEL_DISABLED','DISPATCH_MODE_NOT_CONFIGURED','META_PROVIDER_NOT_CONFIGURED',
    'PILOT_RECIPIENTS_NOT_CONFIGURED','PILOT_RECIPIENT_NOT_ALLOWED','TEMPLATE_NOT_APPROVED',
    'INGEST_NOT_CONFIGURED','INVALID_EVENT','UNAUTHORIZED',
    'PROVIDER_REJECTED','PROVIDER_UNAVAILABLE','RATE_LIMITED','UNKNOWN_OUTCOME'
  ]);
  const code=allowedErrors.has(data?.error)?data.error:'PILOT_REJECTED_OR_UNKNOWN';
  throw new Error('PILOT_NOT_ACCEPTED_HTTP_'+response.status+'_'+code+'_NO_RETRY');
}

async function main(){
  if(process.argv.length!==3||!['--check','--send'].includes(process.argv[2]))
    throw new Error('USAGE: node scripts/atelier-meta-pilot-once.mjs --check|--send');
  if(process.argv[2]==='--check'){
    console.log('One-shot pilot: VEHICLE_READY -> am_vehicle_ready_v1:fr (3 variables).');
    console.log('No request sent. Dispatch must be enabled separately for the pilot.');
    return;
  }
  const result=await runPilotOnce();
  console.log('Meta accepted this single attempt (not confirmed delivered).');
  console.log('Provider message ID: '+result.providerMessageId);
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)
  main().catch(error=>{
    console.error(error instanceof Error?error.message:'PILOT_FAILED');
    process.exitCode=1;
  });
