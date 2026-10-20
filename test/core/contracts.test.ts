import assert from "node:assert/strict";
import test from "node:test";
import {
  fromXeptionNotification,parseNotifyEvent,staffMessage,deliveryKey,
  InvalidNotifyEvent
} from "../../src/core/contracts.js";

const source = {
  id:"00000000-0000-4000-8000-111111111111",
  event_type:"stock_low",
  created_at:"2026-10-20T12:00:00.000Z",
  link_to_id:"00000000-0000-4000-8000-222222222222",
  title:"John Doe +237699999999",
  message:"Customer John Doe +237699999999 asked for this phone"
};

test("Xeption notifications map to versioned events without private content",()=>{
  const parsed=fromXeptionNotification(source,{siteUrl:"https://www.xeptionetwork.shop"});
  assert.ok(parsed);
  assert.equal(parsed.version,1);
  assert.equal(parsed.project,"xeption");
  assert.equal(parsed.type,"inventory.stock_low");
  assert.equal(parsed.priority,"high");
  assert.equal(parsed.actionUrl,"https://www.xeptionetwork.shop/admin/inventory");
  assert.equal(JSON.stringify(parsed).includes("John"),false);
  assert.equal(JSON.stringify(parsed).includes("+237"),false);
  const safe=staffMessage(parsed);
  assert.equal(safe.title,"📦 Stock faible");
  assert.equal(JSON.stringify(safe).includes("John"),false);
  assert.equal(JSON.stringify(safe).includes("+237"),false);
});

test("all Xeption event classes normalize without copying PII",()=>{
  const pairs = {
    stock_out:"inventory.stock_out",
    product_missing_image:"catalog.product_missing_image",
    troc_submitted:"barter.requested",
    marketplace_listed:"marketplace.listing_created"
  };
  for (const [event_type,canonical] of Object.entries(pairs)) {
    const evt=fromXeptionNotification({...source,event_type},{siteUrl:"https://xeption.test"});
    assert.equal(evt?.type,canonical);
    assert.ok(evt);
    assert.match(staffMessage(evt).body,/Consultez/);
    assert.doesNotMatch(JSON.stringify(staffMessage(evt)),/John Doe|699999999/);
  }
  assert.equal(fromXeptionNotification({...source,event_type:"unknown"},{siteUrl:"https://xeption.test"}),null);
});

test("unknown types get privacy-safe fallback instead of raw content",()=>{
  const ev=parseNotifyEvent({
    version:1,project:"commerce-factory",id:"123456",
    type:"shops.created",occurredAt:"2026-10-20T12:00:00Z",
    priority:"normal",audience:"staff",resource:{kind:"shop",id:"shop001"}
  });
  assert.match(staffMessage(ev).title,/Nouvelle alerte/);
  assert.equal(staffMessage(ev).actionUrl,undefined);
});

test("strict fields prevent prototype pollution and unsafe URLs",()=>{
  const valid={
    version:1,project:"xeption",id:"123456",type:"catalog.product_missing_image",
    priority:"normal",occurredAt:"2026-10-20T12:00:00Z",
    audience:"staff",resource:{kind:"product",id:"p123"}
  };
  for (const change of [
    {type:"constructor"},{project:"../../../etc"},{version:2},
    {priority:"urgent"},{audience:"customer"},{resource:{id:"p123",kind:"../secret"}},
    {actionUrl:"http://example.com"},{actionUrl:"https://user:pass@example.com"},
    {actionUrl:"javascript:alert(1)"},{actionUrl:"https://example.com/#x"},
    {occurredAt:"yesterday"}
  ]) {
    assert.throws(()=>parseNotifyEvent({...valid,...change}),InvalidNotifyEvent);
  }
  assert.deepEqual(Object.keys(parseNotifyEvent({...valid,untrusted:"name@example.com"})).sort(),
    ["audience","id","occurredAt","priority","project","resource","type","version"].sort());
});

test("idempotency keys are scoped to project and channel",()=>{
  const base=fromXeptionNotification(source,{siteUrl:"https://xeption.test"});
  assert.ok(base);
  assert.notEqual(deliveryKey(base,"telegram"),deliveryKey(base,"whatsapp_waha"));
  assert.notEqual(deliveryKey(base,"telegram"),deliveryKey({...base,project:"atelier-maitre"},"telegram"));
  assert.throws(()=>deliveryKey(base,"invalid" as "telegram"),InvalidNotifyEvent);
});
