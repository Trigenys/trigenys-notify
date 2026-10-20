import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { createServiceServer } from "../src/server.js";
import type { Project } from "../src/notify.js";

const projects: Project[] = [{
  id: "xeption", name: "Xeption", apiKey: "secret".repeat(6),
  channels: [{ provider: "telegram", chatId: "-100123" }]
}];

test("authenticate, deliver and deduplicate incoming events", async (t) => {
  const messages: string[] = [];
  const server = createServiceServer({ name: "trigenys-notify", version: "0.1.0" }, {
    projects, deliver: async (_channel, message) => { messages.push(message); }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = "http://127.0.0.1:" + address.port + "/v1/events";
  const body = JSON.stringify({
    id: "barter:123", type: "barter.requested", subject: "Échange iPhone 13 / Galaxy S24",
    details: { Soulte: "65 000 FCFA" }
  });
  const unauthorized = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body });
  assert.equal(unauthorized.status, 401);
  const headers = { authorization: "Bearer " + projects[0].apiKey, "content-type": "application/json" };
  const delivered = await fetch(url, { method: "POST", headers, body });
  assert.equal(delivered.status, 200);
  assert.equal((await delivered.json() as { status: string }).status, "delivered");
  const repeated = await fetch(url, { method: "POST", headers, body });
  assert.equal((await repeated.json() as { status: string }).status, "duplicate");
  assert.equal(messages.length, 1);
  assert.match(messages[0], /65 000 FCFA/);
  const invalid = await fetch(url, { method: "POST", headers, body: JSON.stringify({ id: "oops" }) });
  assert.equal(invalid.status, 400);
});
