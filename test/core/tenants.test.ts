import assert from "node:assert/strict";
import test from "node:test";
import {prepareDelivery,TenantPolicyError,type TenantPolicy} from "../../src/core/tenants.js";
import {fromXeptionNotification} from "../../src/core/contracts.js";

const event=fromXeptionNotification({
  id:"safe123",event_type:"stock_low",created_at:"2026-10-20T12:00:00Z",
  link_to_id:"product123"
},{siteUrl:"https://www.xeptionetwork.shop"});
if(!event)throw new Error("Missing fixture");

test("new tenant channels are disabled by default",()=>{
  const policy:TenantPolicy={
    project:"xeption",allowedActionOrigins:["https://www.xeptionetwork.shop"],
    channels:{}
  };
  assert.throws(()=>prepareDelivery(event,policy,"whatsapp_waha"),
    (x:unknown)=>x instanceof TenantPolicyError && x.code==="CHANNEL_DISABLED");
});

test("per-tenant routing disallows cross-project and untrusted deep links",()=>{
  const policy:TenantPolicy={
    project:"xeption",allowedActionOrigins:["https://www.xeptionetwork.shop"],
    channels:{telegram:true,whatsapp_waha:false}
  };
  const safe=prepareDelivery(event,policy,"telegram");
  assert.match(safe.title,/Stock faible/);
  assert.equal(safe.actionUrl,"https://www.xeptionetwork.shop/admin/inventory");
  assert.throws(()=>prepareDelivery({...event,project:"atelier-maitre"},policy,"telegram"),
    (e:unknown)=>e instanceof TenantPolicyError && e.code==="UNKNOWN_TENANT");
  assert.throws(()=>prepareDelivery({...event,actionUrl:"https://phishing.test/login"},policy,"telegram"),
    (e:unknown)=>e instanceof TenantPolicyError && e.code==="ACTION_ORIGIN_DENIED");
  assert.throws(()=>prepareDelivery(event,{...policy,allowedActionOrigins:["http://www.xeptionetwork.shop"]},"telegram"),
    (e:unknown)=>e instanceof TenantPolicyError && e.code==="INVALID_ORIGIN");
});
