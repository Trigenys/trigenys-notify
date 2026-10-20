import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { authorize, formatNotification, loadProjects, parseNotification, sendChannel, type Channel, type Project } from "./notify.js";

export interface ServiceInfo { name: string; version: string }
export interface ServiceOptions {
  projects?: Project[];
  deliver?: (channel: Channel, message: string) => Promise<void>;
}

function reply(response: ServerResponse, status: number, data: object): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(data));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += part.length;
    if (size > 65536) throw new Error("PAYLOAD_TOO_LARGE");
    chunks.push(part);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
  catch { throw new Error("INVALID_JSON"); }
}

export function createServiceServer(info: ServiceInfo, options: ServiceOptions = {}) {
  const projects = options.projects ?? loadProjects(process.env.NOTIFY_PROJECTS_JSON);
  const deliver = options.deliver ?? sendChannel;
  const recentlyDelivered = new Map<string, number>();
  const inFlight = new Set<string>();

  return createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const path = request.url?.split("?")[0];
    if (request.method === "GET" && path === "/health") {
      reply(response, 200, { status: "ok", service: info.name, version: info.version });
      return;
    }
    if (request.method !== "POST" || path !== "/v1/events") {
      reply(response, 404, { error: "NOT_FOUND" });
      return;
    }
    const project = authorize(projects, request.headers.authorization);
    if (!project) { reply(response, 401, { error: "UNAUTHORIZED" }); return; }
    if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
      reply(response, 415, { error: "UNSUPPORTED_MEDIA_TYPE" });
      return;
    }
    let payload: unknown;
    try { payload = await readJson(request); }
    catch (error) {
      const tooLarge = error instanceof Error && error.message === "PAYLOAD_TOO_LARGE";
      reply(response, tooLarge ? 413 : 400, { error: tooLarge ? "PAYLOAD_TOO_LARGE" : "INVALID_JSON" });
      return;
    }
    let event;
    try { event = parseNotification(payload); }
    catch { reply(response, 400, { error: "INVALID_EVENT" }); return; }

    const idempotencyKey = project.id + ":" + event.id;
    const now = Date.now();
    for (const [id, expires] of recentlyDelivered) {
      if (expires <= now) recentlyDelivered.delete(id);
    }
    if ((recentlyDelivered.get(idempotencyKey) ?? 0) > now) {
      reply(response, 200, { status: "duplicate", eventId: event.id });
      return;
    }
    if (inFlight.has(idempotencyKey)) {
      reply(response, 409, { error: "IN_PROGRESS", eventId: event.id });
      return;
    }
    inFlight.add(idempotencyKey);
    try {
      const message = formatNotification(project, event);
      const results = await Promise.allSettled(project.channels.map(channel => deliver(channel, message)));
      const failures = results.filter(item => item.status === "rejected");
      if (failures.length) {
        // Never expose provider errors: they may contain API URLs or access tokens.
        reply(response, 502, { status: "failed", eventId: event.id, failedChannels: failures.length });
        return;
      }
      // Process-local deduplication only. Durable delivery is a separate milestone.
      recentlyDelivered.set(idempotencyKey, Date.now() + 86400000);
      reply(response, 200, { status: "delivered", eventId: event.id, channels: project.channels.length });
    } finally {
      inFlight.delete(idempotencyKey);
    }
  });
}
