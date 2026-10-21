import assert from "node:assert/strict";
import test from "node:test";
import {TelegramAdapter,WahaAdapter} from "../../src/core/channels.js";
import {staffMessage,fromXeptionNotification} from "../../src/core/contracts.js";
import {dispatchXeptionWhatsApp,type DispatchEnv} from "../../src/core/dispatch.js";

// Emulates workerd's requirement that a native global fetch cannot be invoked
// as an arbitrary object's method (the runtime throws "Illegal invocation").
function strictReceiverFetch(this:unknown,input:RequestInfo|URL,_init?:RequestInit):Promise<Response>{
  assert.equal(this,undefined,"global fetch must NOT be called as instance.fetch()");
  assert.match(String(input),/^https:\/\//);
  return Promise.resolve(new Response("{}",{status:200}));
}
const event=fromXeptionNotification({
  id:"stock-check",event_type:"stock_low",created_at:"2026-10-21T12:00:00Z"
},{siteUrl:"https://www.xeptionetwork.shop"});
if(!event)throw Error("invalid test event");
const message=staffMessage(event);

test("Cloudflare workerd fetch receiver: WAHA adapter calls detached fetch",async()=>{
  const client=new WahaAdapter({
    baseUrl:"https://notify.trigenys.com",apiKey:"VALID_SAMPLE_API_KEY",
    session:"trigenys-test",groupChatId:"120363123456789@g.us"
  },strictReceiverFetch as typeof fetch);
  const result=await client.send(message);
  assert.equal(result.code,"ACCEPTED");
  assert.equal(result.accepted,true);
});
test("Cloudflare workerd fetch receiver: Telegram adapter calls detached fetch",async()=>{
  const client=new TelegramAdapter({
    token:"123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef",chatId:"-100123456789"
  },strictReceiverFetch as typeof fetch);
  const result=await client.send(message);
  assert.equal(result.accepted,true);
});
test("Xeption -> Trigenys Notify -> WAHA uses detached native fetch",async()=>{
  const env:DispatchEnv={
    WAHA_DISPATCH_ENABLED:"true",
    XEPTION_NOTIFY_INGEST_KEY:"I".repeat(48),
    WAHA_BASE_URL:"https://notify.trigenys.com",
    WAHA_API_KEY:"K".repeat(64),
    WAHA_SESSION:"trigenys-test",
    WAHA_STAFF_GROUP_ID:"120363123456789@g.us"
  };
  const request=new Request("https://worker.example.com/v1/dispatch/xeption/whatsapp",{
    method:"POST",
    headers:{"content-type":"application/json","x-notify-auth":env.XEPTION_NOTIFY_INGEST_KEY??""},
    body:JSON.stringify({
      version:1,project:"xeption",id:"00000000-0000-4000-8000-222222222223",
      type:"inventory.stock_low",occurredAt:"2026-10-21T12:00:00Z",
      priority:"high",audience:"staff",resource:{kind:"inventory",id:"sku123"},
      actionUrl:"https://www.xeptionetwork.shop/admin/inventory"
    })
  });
  const result=await dispatchXeptionWhatsApp(request,env,strictReceiverFetch as typeof fetch);
  assert.equal(result.status,202);
});
