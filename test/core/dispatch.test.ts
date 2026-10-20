import assert from "node:assert/strict";
import test from "node:test";
import {dispatchXeptionWhatsApp,type DispatchEnv} from "../../src/core/dispatch.js";

const origin="https://trigenys-notify-staging-api.lawrynnjennifer.workers.dev";
const path="/v1/dispatch/xeption/whatsapp";
const env:DispatchEnv={
  WAHA_DISPATCH_ENABLED:"true",
  XEPTION_NOTIFY_INGEST_KEY:"T".repeat(48),
  WAHA_BASE_URL:"https://notify.trigenys.com",
  WAHA_API_KEY:"K".repeat(64),
  WAHA_SESSION:"trigenys-test",
  WAHA_STAFF_GROUP_ID:"12000000000000@g.us"
};
const valid={
  version:1,project:"xeption",id:"00000000-0000-4000-8000-222222222222",
  type:"inventory.stock_low",occurredAt:"2026-10-20T19:00:00Z",
  priority:"high",audience:"staff",resource:{kind:"inventory",id:"product123"},
  actionUrl:"https://www.xeptionetwork.shop/admin/inventory"
};
const make=(body:unknown=valid,header:string|null=env.XEPTION_NOTIFY_INGEST_KEY??null)=>{
  return new Request(origin+path,{
    method:"POST",
    headers:{"content-type":"application/json",...(header?{"x-notify-auth":header}:{})},
    body:JSON.stringify(body)
  });
};

test("dispatch is disabled by default; makes no outbound calls",async()=>{
  let calls=0;
  const outbound=(async()=>{calls++;return new Response("",{status:201});}) as typeof fetch;
  assert.equal((await dispatchXeptionWhatsApp(make(),{...env,WAHA_DISPATCH_ENABLED:"false"},outbound)).status,503);
  assert.equal((await dispatchXeptionWhatsApp(make(),{...env,WAHA_API_KEY:undefined},outbound)).status,503);
  assert.equal(calls,0);
});
test("unauthorized requests cannot send even when channel configured",async()=>{
  let calls=0;
  const outbound=(async()=>{calls++;return new Response("",{status:200});}) as typeof fetch;
  assert.equal((await dispatchXeptionWhatsApp(make(valid,"wrong"),env,outbound)).status,401);
  assert.equal((await dispatchXeptionWhatsApp(make(valid,null),env,outbound)).status,401);
  assert.equal((await dispatchXeptionWhatsApp(make(valid,env.XEPTION_NOTIFY_INGEST_KEY+" "),env,outbound)).status,401);
  assert.equal(calls,0);
});
test("Trigenys Notify owns WAHA provider keys; sends one safe message",async()=>{
  let calls=0;
  const outbound=(async (input:RequestInfo|URL,init?:RequestInit)=>{
    calls++;
    assert.equal(String(input),"https://notify.trigenys.com/api/sendText");
    assert.equal(new Headers(init?.headers).get("X-Api-Key"),env.WAHA_API_KEY);
    const data=JSON.parse(String(init?.body)) as Record<string,unknown>;
    assert.equal(data.session,"trigenys-test");
    assert.equal(data.chatId,env.WAHA_STAFF_GROUP_ID);
    assert.equal(data.linkPreview,false);
    assert.match(String(data.text),/Stock faible/);
    assert.doesNotMatch(JSON.stringify(data),/customer name|phone|john@example/);
    return new Response("{}",{status:201});
  }) as typeof fetch;
  const payload={...valid,title:"customer name",message:"john@example phone"};
  const response=await dispatchXeptionWhatsApp(make(payload),env,outbound);
  assert.equal(response.status,202);
  assert.equal(calls,1);
  const result=await response.json() as {accepted:boolean};
  assert.equal(result.accepted,true);
});
test("strict project, type and action origin validation",async()=>{
  let calls=0;
  const outbound=(async()=>{calls++;return new Response("",{status:201});}) as typeof fetch;
  for (const bad of [
    {...valid,project:"commerce-factory"},
    {...valid,type:"alerts.test"},
    {...valid,actionUrl:"https://phishing.example/admin"},
    {...valid,actionUrl:"http://www.xeptionetwork.shop/admin"},
    {...valid,version:2},
    {...valid,priority:"urgent"}
  ]) assert.equal((await dispatchXeptionWhatsApp(make(bad),env,outbound)).status,400);
  assert.equal(calls,0);
});
test("provider errors are redacted and indicated as retryable or permanent",async()=>{
  const retry=(async()=>new Response("PRIVATE phone and key",{status:503})) as typeof fetch;
  const failure=await dispatchXeptionWhatsApp(make(),env,retry);
  assert.equal(failure.status,503);
  assert.doesNotMatch(await failure.text(),/PRIVATE/);
  const unauthorized=(async()=>new Response("PRIVATE phone",{status:401})) as typeof fetch;
  const denied=await dispatchXeptionWhatsApp(make(),env,unauthorized);
  assert.equal(denied.status,502);
  assert.doesNotMatch(await denied.text(),/PRIVATE/);
});
