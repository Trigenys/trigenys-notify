import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { createServiceServer } from "../src/server.js";

test("GET /health returns service readiness", async (t) => {
  const server = createServiceServer({ name: "example-service", version: "0.1.0" });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());

  const address = server.address();
  assert.ok(address && typeof address === "object");

  const response = await fetch(`http://127.0.0.1:${address.port}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: "ok",
    service: "example-service",
    version: "0.1.0"
  });
});

test("unknown routes return 404", async (t) => {
  const server = createServiceServer({ name: "example-service", version: "0.1.0" });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());

  const address = server.address();
  assert.ok(address && typeof address === "object");

  const response = await fetch(`http://127.0.0.1:${address.port}/missing`);
  assert.equal(response.status, 404);
});
