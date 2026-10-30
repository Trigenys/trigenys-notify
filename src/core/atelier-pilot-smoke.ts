import {MetaCloudApiAdapter,type AtelierMetaEnv} from "./meta-cloud.js";

/**
 * A one-time scheduled smoke with explicit opt-in, not a customer dispatch.
 * The global customer WhatsApp channel must remain DISABLED.
 * D1 claim is persisted before any possible outbound Meta request.
 */
export const PILOT_SMOKE_ID="atelier_whatsapp_pilot_20261030_first";

export interface PilotSmokeDatabase {
  prepare(sql:string):{
    bind(...args:(string|number)[]):{
      run():Promise<{meta?:{changes?:number}}>;
    }
  }
}
export interface PilotSmokeEnv extends AtelierMetaEnv {
  NOTIFY_DB?:PilotSmokeDatabase;
  ATELIER_META_PILOT_SMOKE_ENABLED?:string;
}

export async function runAtelierOneShotPilotSmoke(
  env:PilotSmokeEnv,http:typeof fetch=fetch,now:()=>number=Date.now
):Promise<"DISABLED"|"INVALID_RECIPIENT_CONFIG"|"ALREADY_CLAIMED"|"ACCEPTED"|"FAILED">{
  if(env.ATELIER_META_PILOT_SMOKE_ENABLED!=="true"||
     env.ATELIER_META_DISPATCH_ENABLED!=="false"||
     env.ATELIER_META_DISPATCH_MODE!=="pilot"||
     !env.NOTIFY_DB) return "DISABLED";
  // The pilot recipient list is a Cloudflare encrypted secret, not committed.
  const recipient=env.ATELIER_META_PILOT_RECIPIENTS?.trim()??"";
  if(!/^\+[1-9]\d{7,14}$/.test(recipient) ||
     (env.ATELIER_META_PILOT_RECIPIENTS??"").includes(",") ||
     !(env.ATELIER_META_APPROVED_TEMPLATES??"").split(",").includes("am_vehicle_ready_v1:fr"))
    return "INVALID_RECIPIENT_CONFIG";

  // Never attempt a second send, even if an upstream request times out or fails.
  const claimed=await env.NOTIFY_DB.prepare(
    "UPDATE atelier_meta_pilot_smokes SET state='ATTEMPTED', attempted_at_ms=? WHERE id=? AND state='PENDING'"
  ).bind(now(),PILOT_SMOKE_ID).run();
  if(claimed.meta?.changes!==1)return "ALREADY_CLAIMED";

  let accepted=false;
  try{
    const adapter=new MetaCloudApiAdapter(env,http);
    const result=await adapter.sendTemplate({
      eventId:PILOT_SMOKE_ID,
      eventType:"VEHICLE_READY",
      to:recipient,
      templateName:"am_vehicle_ready_v1",
      language:"fr",
      variables:["Jennifer","TEST-2026","Atelier Maître (test)"]
    });
    accepted=result.accepted===true;
  }catch{
    accepted=false;
  }
  // A failure to write the receipt NEVER permits a second send.
  try{
    await env.NOTIFY_DB.prepare(
      "UPDATE atelier_meta_pilot_smokes SET state=?, finished_at_ms=? WHERE id=? AND state='ATTEMPTED'"
    ).bind(accepted?"ACCEPTED":"FAILED",now(),PILOT_SMOKE_ID).run();
  }catch{
    // The ATTEMPTED claim is durable. No retry under any circumstances.
  }
  return accepted?"ACCEPTED":"FAILED";
}
