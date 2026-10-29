import type {NotifyDatabase} from './group-routing.js';
export async function claimEmail(db:NotifyDatabase,project:string,id:string,hash:string,expiresAt:number){
  const token=crypto.randomUUID(),now=Date.now();
  const row=await db.prepare(`INSERT INTO notify_email_deliveries
    (project,event_id,payload_hash,state,claim_token,attempts,expires_at_ms,updated_at_ms)
    VALUES(?1,?2,?3,'sending',?4,1,?5,?6)
    ON CONFLICT(project,event_id) DO UPDATE SET state='sending',claim_token=excluded.claim_token,
      attempts=notify_email_deliveries.attempts+1,updated_at_ms=excluded.updated_at_ms
    WHERE notify_email_deliveries.state='retry' AND notify_email_deliveries.attempts<3
      AND notify_email_deliveries.payload_hash=excluded.payload_hash
    RETURNING claim_token`).bind(project,id,hash,token,expiresAt+86400000,now).first<{claim_token:string}>();
  if(row?.claim_token===token)return {state:'claimed' as const,token};
  const saved=await db.prepare(`SELECT state,payload_hash FROM notify_email_deliveries
    WHERE project=?1 AND event_id=?2`).bind(project,id).first<{state:string;payload_hash:string}>();
  if(!saved)throw Error('EMAIL_RECEIPT_UNAVAILABLE');
  if(saved.payload_hash!==hash)throw Error('EVENT_ID_REUSED');
  return {state:saved.state==='accepted'?'accepted' as const:'blocked' as const};
}
export async function finishEmail(db:NotifyDatabase,project:string,id:string,token:string,state:'accepted'|'retry'|'uncertain'){
  const row=await db.prepare(`UPDATE notify_email_deliveries SET state=?5,updated_at_ms=?6
    WHERE project=?1 AND event_id=?2 AND claim_token=?3 AND state=?4 RETURNING state`)
    .bind(project,id,token,'sending',state,Date.now()).first<{state:string}>();
  if(!row)throw Error('EMAIL_RECEIPT_UNAVAILABLE');
}
export async function cleanupEmailReceipts(db:NotifyDatabase):Promise<void>{
  await db.prepare(`DELETE FROM notify_email_deliveries WHERE rowid IN
    (SELECT rowid FROM notify_email_deliveries WHERE expires_at_ms<?1 ORDER BY expires_at_ms LIMIT 200)`)
    .bind(Date.now()).run();
}
