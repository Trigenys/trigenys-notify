#!/usr/bin/env node
/**
 * Trigenys Notify WAHA test harness.
 *
 * --mock  : no network or WhatsApp session needed
 * --check : read the configured WAHA session status; never sends
 * --send  : requires explicit operator request; sends ONE fixed test message
 *
 * The sender in Xeption is NOT changed. Credentials are never logged.
 */
import { WahaAdapter } from "../dist/src/core/channels.js";

const mode=process.argv[2] ?? "--check";
const MAX_DURATION_MS=12000;
const safeFixture={
  project:"trigenys-notify",
  eventId:"manual-smoke-"+Date.now(),
  title:"[TEST] Trigenys Notify",
  body:"Ceci est un test du canal WhatsApp. Aucun stock, troc ou produit Xeption n'a été modifié.",
  priority:"normal"
};

function validHost(raw) {
  let url;
  try {url=new URL(raw);} catch {throw new Error("WAHA_BASE_URL must be a valid HTTPS origin");}
  if(url.protocol!=="https:" || url.username || url.password ||
     url.hash || url.search || url.port ||
     (url.pathname!=="/" && url.pathname!=="")) {
    throw new Error("WAHA_BASE_URL must be an HTTPS origin without path, port or credentials");
  }
  return url.origin;
}
function sessionName(s) {
  if(!/^[A-Za-z0-9_-]{1,48}$/.test(s))throw new Error("WAHA_SESSION invalid");
  return s;
}
function apiKey(s) {
  if(typeof s!=="string" || s.length<8)throw new Error("WAHA_API_KEY must be provided via environment");
  return s;
}
function envConfig(send=false) {
  const baseUrl=validHost(process.env.WAHA_BASE_URL||"");
  const session=sessionName(process.env.WAHA_SESSION||"");
  const key=apiKey(process.env.WAHA_API_KEY);
  const groupChatId=process.env.WAHA_STAFF_GROUP_ID||"";
  if(send && !/^[0-9-]+@g\.us$/.test(groupChatId))
    throw new Error("WAHA_STAFF_GROUP_ID must identify an opted-in test WhatsApp group (@g.us)");
  return {baseUrl,session,key,groupChatId};
}
async function check(cfg) {
  const res=await fetch(cfg.baseUrl+"/api/sessions/"+encodeURIComponent(cfg.session),{
    headers:{"X-Api-Key":cfg.key,"accept":"application/json"},
    signal:AbortSignal.timeout(MAX_DURATION_MS)
  });
  if(!res.ok)throw new Error("WAHA session read failed (HTTP "+res.status+"). Check host/key/session.");
  // Do not log session details (phone, QR, device ID, contacts).
  const data=await res.json();
  const status=typeof data.status==="string" ? data.status : "UNKNOWN";
  console.log("WAHA session status:",status);
  if(status!=="WORKING")throw new Error("WAHA session is not WORKING. Pair your device by QR first.");
}
async function main() {
  if(mode==="--mock") {
    let calls=0;
    const mockFetch=async (_input,options)=>{
      calls++;
      const body=JSON.parse(String(options?.body));
      if(body.chatId!=="111222333@g.us" || !body.text.includes("[TEST] Trigenys Notify"))
        throw new Error("Unexpected WAHA test payload");
      return new Response(JSON.stringify({id:"mock"}),{status:201});
    };
    const adapter=new WahaAdapter({
      baseUrl:"https://waha.mock.test",apiKey:"MOCK_SECRET_ONLY",
      session:"test",groupChatId:"111222333@g.us"
    },mockFetch);
    const outcome=await adapter.send(safeFixture);
    if(!outcome.accepted || calls!==1)throw new Error("Mock transport test failed");
    console.log("WAHA mock passed: one accepted request, zero real messages.");
    return;
  }
  if(mode!=="--check" && mode!=="--send")
    throw new Error("Usage: node scripts/waha-smoke.mjs --mock | --check | --send");
  const cfg=envConfig(mode==="--send");
  await check(cfg);
  if(mode==="--check") {
    console.log("Read-only WAHA check passed. No messages sent.");
    return;
  }
  const adapter=new WahaAdapter({
    baseUrl:cfg.baseUrl,apiKey:cfg.key,session:cfg.session,groupChatId:cfg.groupChatId
  });
  const outcome=await adapter.send(safeFixture);
  if(!outcome.accepted) {
    throw new Error("WAHA test was not accepted ("+outcome.code+", HTTP "+(outcome.status??"network")+").");
  }
  console.log("One test message accepted by WAHA; confirm its arrival in the test WhatsApp group.");
}
main().catch(error=>{
  // Sanitized errors only: do not emit raw HTTP bodies, tokens or group IDs.
  console.error("WAHA smoke failed:",error instanceof Error?error.message:"unexpected error");
  process.exitCode=1;
});
