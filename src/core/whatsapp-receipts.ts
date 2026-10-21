import type {NotifyDatabase,ProjectGroup} from './group-routing.js';

export async function deliveryPlan(db:NotifyDatabase,project:string,eventId:string,
  payloadHash:string,recipients:ProjectGroup[]):Promise<ProjectGroup[]|null>{
  if(recipients.length){
    await db.prepare(`INSERT INTO notify_whatsapp_events
      (project,event_id,payload_hash,recipients_json,created_at_ms)
      VALUES(?1,?2,?3,?4,?5) ON CONFLICT(project,event_id) DO NOTHING`)
      .bind(project,eventId,payloadHash,JSON.stringify(recipients),Date.now()).run();
  }
  const saved=await db.prepare(`SELECT payload_hash,recipients_json FROM notify_whatsapp_events
    WHERE project=?1 AND event_id=?2`).bind(project,eventId)
    .first<{payload_hash:string;recipients_json:string}>();
  if(!saved)return null;
  if(saved.payload_hash!==payloadHash)throw Error('EVENT_ID_REUSED');
  return JSON.parse(saved.recipients_json) as ProjectGroup[];
}

export async function claimRecipient(db:NotifyDatabase,project:string,eventId:string,
  recipient:ProjectGroup):Promise<{state:'claimed';token:string}|{state:'accepted'}|{state:'busy'}>{
  const token=crypto.randomUUID(),now=Date.now();
  const claim=await db.prepare(`INSERT INTO notify_whatsapp_receipts
    (project,event_id,session,group_id,state,claim_token,lease_until_ms)
    VALUES(?1,?2,?3,?4,'sending',?5,?6)
    ON CONFLICT(project,event_id,session,group_id) DO UPDATE SET
    state='sending',claim_token=excluded.claim_token,lease_until_ms=excluded.lease_until_ms
    WHERE notify_whatsapp_receipts.state='pending' OR
      (notify_whatsapp_receipts.state='sending' AND notify_whatsapp_receipts.lease_until_ms<=?7)
    RETURNING claim_token`)
    .bind(project,eventId,recipient.session,recipient.groupId,token,now+60000,now)
    .first<{claim_token:string}>();
  if(claim?.claim_token===token)return {state:'claimed',token};
  const row=await db.prepare(`SELECT state FROM notify_whatsapp_receipts
    WHERE project=?1 AND event_id=?2 AND session=?3 AND group_id=?4`)
    .bind(project,eventId,recipient.session,recipient.groupId).first<{state:string}>();
  return {state:row?.state==='accepted'?'accepted':'busy'};
}

export async function finishRecipient(db:NotifyDatabase,project:string,eventId:string,
  recipient:ProjectGroup,token:string,accepted:boolean):Promise<void>{
  await db.prepare(`UPDATE notify_whatsapp_receipts SET state=?6,lease_until_ms=0
    WHERE project=?1 AND event_id=?2 AND session=?3 AND group_id=?4 AND claim_token=?5`)
    .bind(project,eventId,recipient.session,recipient.groupId,token,accepted?'accepted':'pending').run();
}
