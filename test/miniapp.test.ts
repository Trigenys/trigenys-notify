import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { createHmac } from "node:crypto";
import { createServiceServer } from "../src/server.js";
import { fakeFetch, settings } from "./xeption-gateway.test.js";

function initData() {
  const fields = { auth_date: String(Math.floor(Date.now()/1000)),
    user: JSON.stringify({ id: 279058397, first_name: "Staff" }) };
  const check = Object.entries(fields).sort(([a], [b]) => a.localeCompare(b, "en"))
    .map(([k,v]) => k + "=" + v).join("\n");
  const key = createHmac("sha256", "WebAppData").update(settings.botToken).digest();
  const hash = createHmac("sha256", key).update(check).digest("hex");
  return new URLSearchParams({ ...fields, hash }).toString();
}

test("Mini App routes deny unauthorized requests and expose public config only", async (t) => {
  const server = createServiceServer({name:"trigenys-notify",version:"0.1.0"}, {
    miniappSettings: settings, fetchImpl: fakeFetch([])
  });
  server.listen(0,"127.0.0.1");
  await once(server,"listening");
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = "http://127.0.0.1:" + address.port;
  const config = await (await fetch(base + "/v1/miniapp/public-config")).json() as Record<string,unknown>;
  assert.equal(config.supabaseAnonKey,"PUBLIC_ANON_KEY");
  assert.equal(JSON.stringify(config).includes("PRIVATE_SERVICE_KEY"),false);
  assert.equal(JSON.stringify(config).includes(settings.botToken),false);
  const unauthorized = await fetch(base + "/v1/miniapp/items?category=alerts");
  assert.equal(unauthorized.status,401);
  const tampered = await fetch(base + "/v1/miniapp/items", {
    headers: { "x-telegram-init-data": initData().replace("Staff", "Hacker") }
  });
  assert.equal(tampered.status,401);
  const ok = await fetch(base + "/v1/miniapp/items?category=alerts", {
    headers: { "x-telegram-init-data": initData() }
  });
  assert.equal(ok.status,200);
  const data = await ok.json() as {items:unknown[]};
  assert.equal(data.items.length,1);
  const denied = await fetch(base + "/v1/miniapp/items?category=trocs", {
    headers: { "x-telegram-init-data": initData() }
  });
  assert.equal(denied.status,403);
  const ack = await fetch(base + "/v1/miniapp/ack", {
    method:"POST", headers: { "x-telegram-init-data": initData(), "content-type":"application/json" },
    body: JSON.stringify({id:"99999999-9999-4999-9999-999999999999"})
  });
  assert.equal(ack.status,403);
  const page = await fetch(base + "/miniapp");
  assert.equal(page.status,200);
  assert.match(await page.text(), /Xeption/);
  assert.match(page.headers.get("content-security-policy") || "", /telegram.org/);
});
