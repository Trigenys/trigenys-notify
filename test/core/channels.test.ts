import assert from "node:assert/strict";
import test from "node:test";
import {TelegramAdapter,WahaAdapter,type DeliveryResult} from "../../src/core/channels.js";
import {staffMessage,fromXeptionNotification} from "../../src/core/contracts.js";

const notification=fromXeptionNotification({
  id:"notify123",event_type:"troc_submitted",created_at:"2026-10-20T12:00:00Z"
},{siteUrl:"https://www.xeptionetwork.shop"});
if (!notification) throw new Error("test fixture invalid");
const safe=staffMessage(notification);

test("WAHA uses official sendText group API with scoped session and API key",async()=>{
  let url="";
  let body: Record<string,unknown>={};
  let key="";
  const mock=(async (input:URL|string|Request,options?:RequestInit)=>{
    url=String(input);
    key=new Headers(options?.headers).get("X-Api-Key") || "";
    body=JSON.parse(String(options?.body)) as Record<string,unknown>;
    return new Response("{}",{status:200});
  }) as typeof fetch;
  const client=new WahaAdapter({
    baseUrl:"https://waha.example.com",apiKey:"SERVER_ONLY_SECRET",
    session:"xeption-staff",groupChatId:"120363001234567890@g.us"
  },mock);
  const result=await client.send(safe);
  assert.deepEqual(result,{accepted:true,retryable:false,code:"ACCEPTED",status:200});
  assert.equal(url,"https://waha.example.com/api/sendText");
  assert.equal(key,"SERVER_ONLY_SECRET");
  assert.equal(body.session,"xeption-staff");
  assert.equal(body.chatId,"120363001234567890@g.us");
  assert.equal(body.linkPreview,false);
  assert.match(String(body.text),/Nouvelle demande de troc/);
  assert.doesNotMatch(JSON.stringify(body),/\+237|password|client@example/);
});

test("WAHA disallows non-TLS origin, credentials and personal chats",()=>{
  const base={baseUrl:"https://waha.example.com",apiKey:"SERVER_ONLY_SECRET",session:"default",
    groupChatId:"123456@g.us"};
  for(const change of [
    {baseUrl:"http://waha.example.com"},
    {baseUrl:"https://user:pass@waha.example.com"},
    {baseUrl:"https://waha.example.com/other"},
    {groupChatId:"123456@c.us"},
    {apiKey:"short"},
    {session:"../../"},
  ]) assert.throws(()=>new WahaAdapter({...base,...change}));
});

test("WAHA status handling differentiates provider rejection and retries",async()=>{
  const base={baseUrl:"https://waha.example.com",apiKey:"SERVER_ONLY_SECRET",session:"default",
    groupChatId:"123456@g.us"};
  const cases: Array<[number,DeliveryResult["code"],boolean]>= [
    [400,"PROVIDER_REJECTED",false],
    [401,"PROVIDER_REJECTED",false],
    [429,"RATE_LIMITED",true],
    [503,"PROVIDER_UNAVAILABLE",true]
  ];
  for(const [status,code,retryable] of cases){
    const adapter=new WahaAdapter(base,(async()=>new Response("PRIVATE_UPSTREAM_ERROR",{status})) as typeof fetch);
    const result=await adapter.send(safe);
    assert.equal(result.accepted,false);
    assert.equal(result.code,code);
    assert.equal(result.retryable,retryable);
    assert.equal(JSON.stringify(result).includes("PRIVATE_UPSTREAM_ERROR"),false);
  }
  const network=new WahaAdapter(base,(async()=>{throw Error("Bearer credentials");}) as typeof fetch);
  const failed=await network.send(safe);
  assert.equal(failed.code,"NETWORK_ERROR");
  assert.equal(failed.retryable,true);
  assert.equal(JSON.stringify(failed).includes("credentials"),false);
});

test("Telegram transport remains optional; no user or bot data leaked",async()=>{
  let apiUrl="";let body:Record<string,unknown>={};
  const fake=(async (input:RequestInfo|URL,init?:RequestInit)=>{
    apiUrl=String(input);
    body=JSON.parse(String(init?.body)) as Record<string,unknown>;
    return new Response("{}",{status:200});
  }) as typeof fetch;
  const token="123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef";
  const adapter=new TelegramAdapter({token,chatId:"-100123456789"},fake);
  assert.equal((await adapter.send(safe)).accepted,true);
  assert.match(apiUrl,/api.telegram.org\/bot/);
  assert.equal(body.chat_id,"-100123456789");
  assert.doesNotMatch(JSON.stringify(body),/John Doe|699999999/);
  assert.throws(()=>new TelegramAdapter({token:"",chatId:"-100123456789"}));
});

test("module construction does not transmit anything without an explicit send call",()=>{
  let calls=0;
  const http=(async()=>{calls++;return new Response();}) as typeof fetch;
  new WahaAdapter({baseUrl:"https://waha.example.com",apiKey:"SERVER_ONLY_SECRET",
    session:"default",groupChatId:"111111@g.us"},http);
  new TelegramAdapter({token:"123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef",chatId:"-100123456789"},http);
  assert.equal(calls,0);
});
