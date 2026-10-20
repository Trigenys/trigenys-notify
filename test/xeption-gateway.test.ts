import assert from "node:assert/strict";
import test from "node:test";
import { MiniAppError } from "../src/telegram-auth.js";
import { XeptionGateway, normalizedRole, roleAllows, type MiniAppSettings } from "../src/xeption-gateway.js";

export const settings: MiniAppSettings = {
  enabled: true, writesEnabled: false, botToken: "123:secret",
  supabaseUrl: "https://example.supabase.co",
  supabaseAnonKey: "PUBLIC_ANON_KEY", supabaseServiceKey: "PRIVATE_SERVICE_KEY",
  xeptionSiteUrl: "https://www.xeptionetwork.shop"
};

type FetchCalls = { url: URL; auth: string }[];
export function fakeFetch(calls: FetchCalls, link = true): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    calls.push({ url, auth: headers.get("authorization") || "" });
    const path = url.pathname;
    let body: unknown = [];
    if (path === "/rest/v1/telegram_staff_links") {
      body = init?.method === "POST" ? [{telegram_user_id: "279058397"}] :
        link ? [{ auth_user_id: "cccccccc-cccc-4ccc-accc-cccccccccccc" }] : [];
    } else if (path === "/auth/v1/user") {
      body = { id: "cccccccc-cccc-4ccc-accc-cccccccccccc", email: "staff@xeption.test" };
    } else if (path.startsWith("/auth/v1/admin/users/")) {
      body = { id: "cccccccc-cccc-4ccc-accc-cccccccccccc", email: "staff@xeption.test" };
    } else if (path === "/rest/v1/staff") {
      body = [{ name: "Awa", email: "staff@xeption.test", role: "vendeur" }];
    } else if (path === "/rest/v1/admin_notifications") {
      body = [
        {id: "1", title: "Stock faible", target_role: null},
        {id: "2", title: "Troc réservé", target_role: "responsable"}
      ];
    } else if (path === "/rest/v1/products") {
      body = [{id:"product-1",name:"Redmi Note 15",stock:2}];
    } else if (path === "/rest/v1/rpc/ack_staff_notification_from_telegram") {
      body = true;
    } else {
      body = [{id:"one"}];
    }
    return new Response(JSON.stringify(body), {
      status: 200, headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;
}

test("strict staff roles and checks", () => {
  assert.equal(normalizedRole("unknown"), null);
  assert.equal(normalizedRole("manager"), "responsable");
  assert.equal(roleAllows("vendeur", "responsable"), false);
  assert.equal(roleAllows("direction", "responsable"), true);
  assert.equal(roleAllows("super_admin", "unknown"), false);
});

test("only Xeption staff linked to a Telegram user may read and role filters apply", async () => {
  const calls: FetchCalls = [];
  const gateway = new XeptionGateway(settings, fakeFetch(calls));
  const staff = await gateway.requireLinkedStaff("279058397");
  assert.equal(staff.role, "vendeur");
  const alerts = await gateway.list("alerts", staff);
  assert.deepEqual(alerts.map(x => x.title), ["Stock faible"]);
  const stocks = await gateway.list("stock", staff);
  assert.equal(stocks.length, 1);
  await assert.rejects(gateway.list("trocs", staff), (e: unknown) =>
    e instanceof MiniAppError && e.status === 403);
  assert.equal(calls.some(c => c.url.pathname === "/rest/v1/admin_notifications" &&
    c.auth === "Bearer PRIVATE_SERVICE_KEY"), true);
});

test("revoked or absent linked account cannot read", async () => {
  const gateway = new XeptionGateway(settings, fakeFetch([], false));
  await assert.rejects(gateway.requireLinkedStaff("279058397"), (e: unknown) =>
    e instanceof MiniAppError && e.code === "LINK_XEPTION_ACCOUNT");
});

test("link uses current Xeption auth token and rejects conflicting account", async () => {
  const calls: FetchCalls = [];
  const gateway = new XeptionGateway(settings, fakeFetch(calls, false));
  const staff = await gateway.linkTelegram("279058397", "VALID_USER_JWT");
  assert.equal(staff.name, "Awa");
  assert.equal(calls.find(c => c.url.pathname === "/auth/v1/user")?.auth, "Bearer VALID_USER_JWT");
  assert.equal(calls.some(c => c.url.pathname === "/rest/v1/telegram_staff_links"), true);
});

test("writes disabled by default", async () => {
  const gateway = new XeptionGateway(settings, fakeFetch([]));
  await assert.rejects(gateway.acknowledge("abc", "279058397"), (e: unknown) =>
    e instanceof MiniAppError && e.code === "MINIAPP_READ_ONLY");
});
