/**
 * WAHA session watchdog. Runs on the existing five-minute cron.
 *
 * Health is the success of the group sync that the cron already performs.
 * The last healthy time is notify_whatsapp_discovery.last_synced_ms, so the
 * watchdog needs no extra state or schema. The operator is alerted on Telegram,
 * never on WhatsApp, because WhatsApp is the channel that is down.
 *
 * Alerts: one after WATCHDOG_GRACE_MS of outage, then one every
 * WATCHDOG_REMINDER_MS, then one on recovery. Cron ticks are exactly
 * WATCHDOG_TICK_MS apart (scheduledTime), so each window matches one tick.
 */
import {syncWahaGroups,type GroupEnv} from './group-routing.js';
import {TelegramAdapter} from './channels.js';

export const WATCHDOG_TICK_MS=5*60_000;
export const WATCHDOG_GRACE_MS=10*60_000;
export const WATCHDOG_REMINDER_MS=6*3_600_000;

export interface WatchdogEnv extends GroupEnv {
  TELEGRAM_BOT_TOKEN?:string;
  OPS_TELEGRAM_CHAT_ID?:string;
}
export type SessionStatus='WORKING'|'SCAN_QR_CODE'|'STARTING'|'STOPPED'|'FAILED'|'UNREACHABLE'|'UNKNOWN';
const known=new Set<SessionStatus>(['WORKING','SCAN_QR_CODE','STARTING','STOPPED','FAILED']);
export type WatchdogAlert={kind:'down'|'recovered';outageMs:number}|null;

/** Reads the session status for the alert text only; never throws. */
export async function readSessionStatus(env:WatchdogEnv,http:typeof fetch=fetch):Promise<SessionStatus>{
  if(!env.WAHA_BASE_URL||!env.WAHA_API_KEY||!env.WAHA_SESSION)return 'UNKNOWN';
  try{
    const response=await http(new URL('/api/sessions/'+encodeURIComponent(env.WAHA_SESSION),env.WAHA_BASE_URL).href,{
      headers:{'X-Api-Key':env.WAHA_API_KEY,accept:'application/json'},
      signal:AbortSignal.timeout(8000),redirect:'manual'});
    if(!response.ok)return response.status>=500?'UNREACHABLE':'UNKNOWN';
    const body=await response.json() as {status?:unknown};
    return typeof body?.status==='string'&&known.has(body.status as SessionStatus)
      ?body.status as SessionStatus:'UNKNOWN';
  }catch{return 'UNREACHABLE';}
}

/** Pure decision. lastHealthyMs is the previous successful sync, read before this tick's sync. */
export function watchdogDecision(input:{healthy:boolean;lastHealthyMs:number|null;now:number}):WatchdogAlert{
  const {healthy,lastHealthyMs,now}=input;
  if(healthy){
    if(lastHealthyMs===null)return null;
    const outageMs=now-lastHealthyMs;
    return outageMs>=WATCHDOG_GRACE_MS?{kind:'recovered',outageMs}:null;
  }
  if(lastHealthyMs===null){
    // No healthy baseline yet: remind on a fixed six-hour grid.
    return now%WATCHDOG_REMINDER_MS<WATCHDOG_TICK_MS?{kind:'down',outageMs:0}:null;
  }
  const outageMs=now-lastHealthyMs;
  if(outageMs<WATCHDOG_GRACE_MS)return null;
  return (outageMs-WATCHDOG_GRACE_MS)%WATCHDOG_REMINDER_MS<WATCHDOG_TICK_MS?{kind:'down',outageMs}:null;
}

export function formatDuration(ms:number):string{
  const minutes=Math.max(0,Math.floor(ms/60_000));
  const days=Math.floor(minutes/1440),hours=Math.floor(minutes%1440/60),rest=minutes%60;
  if(days)return days+' j '+hours+' h';
  if(hours)return hours+' h '+String(rest).padStart(2,'0');
  return rest+' min';
}

const statusText:Record<SessionStatus,[string,string]>={
  WORKING:['connectée, mais la liste des groupes est illisible','consulter les journaux de Notify'],
  SCAN_QR_CODE:['déconnectée','rescanner le QR code dans le tableau de bord WAHA'],
  STARTING:['en cours de démarrage','vérifier dans 10 minutes qu’elle passe à WORKING'],
  STOPPED:['arrêtée','démarrer la session dans le tableau de bord WAHA'],
  FAILED:['en échec','redémarrer la session dans le tableau de bord WAHA'],
  UNREACHABLE:['serveur WAHA injoignable','vérifier le VPS et le conteneur WAHA'],
  UNKNOWN:['état inconnu','ouvrir le tableau de bord WAHA'],
};

export function watchdogMessage(alert:NonNullable<WatchdogAlert>,status:SessionStatus,session:string){
  if(alert.kind==='recovered')return {title:'🟢 WhatsApp rétabli',
    body:'Session '+session+' de nouveau opérationnelle après '+formatDuration(alert.outageMs)+
      ' d’interruption.\nLes messages refusés pendant la panne ne sont pas renvoyés automatiquement.'};
  const [state,action]=statusText[status];
  return {title:'🔴 WhatsApp en panne',
    body:'Session '+session+' : '+state+'.\n'+
      (alert.outageMs?'Depuis : '+formatDuration(alert.outageMs)+'\n':'')+
      'Action : '+action+'.\nLes notifications WhatsApp ne partent plus.'};
}

/** Cron entry point. Keeps the previous behavior: the group sync always runs. */
export async function runWahaWatchdog(env:WatchdogEnv,now:number,http:typeof fetch=fetch):Promise<WatchdogAlert>{
  if(!env.NOTIFY_DB||!env.WAHA_SESSION)throw Error('WAHA_DISCOVERY_NOT_CONFIGURED');
  const previous=await env.NOTIFY_DB.prepare(`SELECT last_synced_ms FROM notify_whatsapp_discovery WHERE session=?1`)
    .bind(env.WAHA_SESSION).first<{last_synced_ms:number}>();
  let healthy=true;
  try{await syncWahaGroups(env,http);}catch{healthy=false;}
  const alert=watchdogDecision({healthy,lastHealthyMs:previous?.last_synced_ms??null,now});
  if(!alert)return null;
  if(!env.TELEGRAM_BOT_TOKEN||!env.OPS_TELEGRAM_CHAT_ID){
    console.warn('notify.waha_watchdog_alert_unconfigured',alert.kind);
    return alert;
  }
  const status=alert.kind==='down'?await readSessionStatus(env,http):'WORKING';
  const message=watchdogMessage(alert,status,env.WAHA_SESSION);
  const result=await new TelegramAdapter({token:env.TELEGRAM_BOT_TOKEN,chatId:env.OPS_TELEGRAM_CHAT_ID},http)
    .send({project:'notify',eventId:'waha-watchdog-'+now,priority:'high',...message});
  if(!result.accepted)console.warn('notify.waha_watchdog_alert_failed',result.code);
  return alert;
}
