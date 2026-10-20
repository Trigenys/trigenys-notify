import assert from "node:assert/strict";
import test from "node:test";
import { authorize, formatNotification, loadProjects, parseNotification, type Project } from "../src/notify.js";

const projects: Project[] = [{ id: "xeption", name: "Xeption", apiKey: "x".repeat(32), channels: [{ provider: "telegram", chatId: "-1001" }] }];

test("per-project authorization", () => {
  assert.equal(authorize(projects, "Bearer " + "x".repeat(32))?.id, "xeption");
  assert.equal(authorize(projects, "Bearer invalid"), undefined);
  assert.equal(authorize(projects, undefined), undefined);
});

test("safe validation and readable stock notification", () => {
  const item = parseNotification({ id: "stock:1", type: "stock.low", subject: "Redmi Note 15", details: { Restant: 2, Seuil: 3 }, url: "https://xeption.example/products/1" });
  const rendered = formatNotification(projects[0], item);
  assert.match(rendered, /Stock faible/);
  assert.match(rendered, /Restant : 2/);
  assert.match(rendered, /https:\/\/xeption.example/);
  assert.throws(() => parseNotification({ ...item, url: "javascript:alert(1)" }));
  assert.throws(() => parseNotification({ ...item, type: "unknown" }));
  assert.throws(() => parseNotification({ ...item, type: "constructor" }));
});

test("project configuration fails closed", () => {
  assert.deepEqual(loadProjects(undefined), []);
  assert.throws(() => loadProjects(JSON.stringify([{ id: "xeption", name: "Xeption", apiKey: "short", channels: [] }])));
});
