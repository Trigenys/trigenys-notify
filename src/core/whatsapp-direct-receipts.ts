import type {NotifyDatabase} from './group-routing.js';
const TABLE='notify_whatsapp_direct_deliveries';
export type DirectState='accepted'|'retry'|'rejected'|'uncertain';

export async function readDirect(db:NotifyDatabase,project:string,id:string){
  return db.prepare(`SELECT state,payload_hash FROM ${TABLE} WHERE project=?1 AND event_id=?2`)
    .bind(project,id).first<{state:string;payload_hash:string}>();
}
/** Window counts for the project and one recipient fingerprint, excluding the event's own receipt. */
export async function countRecentDirect(db:NotifyDatabase,project:string,id:string,recipientHash:string,since:number){
  const row=await db.prepare(`SELECT count(*) AS total,
      sum(CASE WHEN recipient_hash=?2 THEN 1 ELSE 0 END) AS recipient
    FROM ${TABLE} WHERE project=?1 AND created_at_ms>=?3 AND event_id<>?4`)
    .bind(project,recipientHash,since,id).first<{total:number;recipient:number|null}>();
  return {project:Number(row?.total??0),recipient:Number(row?.recipient??0)};
}
export async function claimDirect(db:NotifyDatabase,project:string,id:string,hash:string,recipientHash:string,expiresAt:number,now=Date.now()){
  const token=crypto.randomUUID();
  const row=await db.prepare(`INSERT INTO ${TABLE}
    (project,event_id,payload_hash,recipient_hash,state,claim_token,attempts,created_at_ms,expires_at_ms,updated_at_ms)
    VALUES(?1,?2,?3,?4,'sending',?5,1,?7,?6,?7)
    ON CONFLICT(project,event_id) DO UPDATE SET state='sending',claim_token=excluded.claim_token,
      attempts=${TABLE}.attempts+1,updated_at_ms=excluded.updated_at_ms
    WHERE ${TABLE}.state='retry' AND ${TABLE}.attempts<3
      AND ${TABLE}.payload_hash=excluded.payload_hash
    RETURNING claim_token`).bind(project,id,hash,recipientHash,token,expiresAt+86400000,now).first<{claim_token:string}>();
  if(row?.claim_token===token)return {state:'claimed' as const,token};
  const saved=await db.prepare(`SELECT state,payload_hash FROM ${TABLE}
    WHERE project=?1 AND event_id=?2`).bind(project,id).first<{state:string;payload_hash:string}>();
  if(!saved)throw Error('RECEIPT_UNAVAILABLE');
  if(saved.payload_hash!==hash)throw Error('EVENT_ID_REUSED');
  return {state:saved.state==='accepted'?'accepted' as const:saved.state==='rejected'?'rejected' as const:'blocked' as const};
}
export async function finishDirect(db:NotifyDatabase,project:string,id:string,token:string,state:DirectState,now=Date.now()){
  const row=await db.prepare(`UPDATE ${TABLE} SET state=?5,updated_at_ms=?6
    WHERE project=?1 AND event_id=?2 AND claim_token=?3 AND state=?4 RETURNING state`)
    .bind(project,id,token,'sending',state,now).first<{state:string}>();
  if(!row)throw Error('RECEIPT_UNAVAILABLE');
}
export async function cleanupDirectReceipts(db:NotifyDatabase):Promise<void>{
  await db.prepare(`DELETE FROM ${TABLE} WHERE rowid IN
    (SELECT rowid FROM ${TABLE} WHERE expires_at_ms<?1 ORDER BY expires_at_ms LIMIT 200)`)
    .bind(Date.now()).run();
}
