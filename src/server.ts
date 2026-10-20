import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { MiniAppError, verifyTelegramInitData } from "./telegram-auth.js";
import { XeptionGateway, settingsFromEnv, type MiniAppSettings } from "./xeption-gateway.js";

export interface ServiceInfo { name: string; version: string }
export interface ServiceOptions {
  miniappSettings?: MiniAppSettings;
  fetchImpl?: typeof fetch;
}

function json(response: ServerResponse, status: number, body: object): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer"
  });
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
    throw new MiniAppError(415, "JSON_REQUIRED");
  }
  let total = 0;
  const chunks: Buffer[] = [];
  for await (const data of request) {
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
    total += chunk.length;
    if (total > 8192) throw new MiniAppError(413, "BODY_TOO_LARGE");
    chunks.push(chunk);
  }
  try {
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("not object");
    return body as Record<string, unknown>;
  } catch { throw new MiniAppError(400, "INVALID_JSON"); }
}

export function createServiceServer(info: ServiceInfo, options: ServiceOptions = {}) {
  const settings = options.miniappSettings || settingsFromEnv();
  const gateway = new XeptionGateway(settings, options.fetchImpl);
  return createServer(async (request: IncomingMessage, response: ServerResponse) => {
    try {
      const pathname = new URL(request.url || "/", "http://localhost").pathname;
      if (request.method === "GET" && pathname === "/health") {
        json(response, 200, { status: "ok", service: info.name, version: info.version });
        return;
      }
      const assets: Record<string, [string, string]> = {
        "/miniapp": ["miniapp.html", "text/html; charset=utf-8"],
        "/miniapp/app.js": ["app.js", "text/javascript; charset=utf-8"],
        "/miniapp/styles.css": ["styles.css", "text/css; charset=utf-8"]
      };
      if (request.method === "GET" && assets[pathname]) {
        const [file, type] = assets[pathname];
        const bytes = await readFile(join(process.cwd(), "web", file));
        response.writeHead(200, {
          "content-type": type, "cache-control": "no-store",
          "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
          "content-security-policy": "default-src 'none'; script-src 'self' https://telegram.org; style-src 'self'; connect-src 'self' " +
            (settings.supabaseUrl || "'none'") +
            "; img-src 'self' data:; frame-ancestors https://web.telegram.org https://webk.telegram.org https://webz.telegram.org; base-uri 'none'; form-action 'self'"
        });
        response.end(bytes);
        return;
      }
      if (!pathname.startsWith("/v1/miniapp/")) {
        json(response, 404, { error: "NOT_FOUND" });
        return;
      }
      if (!gateway.isConfigured()) throw new MiniAppError(503, "MINIAPP_NOT_CONFIGURED");
      if (request.method === "GET" && pathname === "/v1/miniapp/public-config") {
        json(response, 200, {
          supabaseUrl: settings.supabaseUrl,
          supabaseAnonKey: settings.supabaseAnonKey,
          xeptionSiteUrl: settings.xeptionSiteUrl,
          writesEnabled: settings.writesEnabled
        });
        return;
      }
      const raw = request.headers["x-telegram-init-data"];
      if (typeof raw !== "string") throw new MiniAppError(401, "MISSING_TELEGRAM_SESSION");
      const telegram = verifyTelegramInitData(raw, settings.botToken);
      if (request.method === "POST" && pathname === "/v1/miniapp/link") {
        const body = await readBody(request);
        if (typeof body.xeptionAccessToken !== "string") throw new MiniAppError(400, "XEPTION_TOKEN_REQUIRED");
        const staff = await gateway.linkTelegram(telegram.id, body.xeptionAccessToken);
        json(response, 200, { linked: true, staff: { name: staff.name, role: staff.role }, telegramName: telegram.displayName });
        return;
      }
      if (request.method === "GET" && pathname === "/v1/miniapp/session") {
        try {
          const staff = await gateway.requireLinkedStaff(telegram.id);
          json(response, 200, { linked: true, staff: { name: staff.name, role: staff.role }, telegramName: telegram.displayName });
        } catch (error) {
          if (error instanceof MiniAppError && error.code === "LINK_XEPTION_ACCOUNT") {
            json(response, 200, { linked: false, telegramName: telegram.displayName });
          } else throw error;
        }
        return;
      }
      if (request.method === "GET" && pathname === "/v1/miniapp/items") {
        const staff = await gateway.requireLinkedStaff(telegram.id);
        const category = new URL(request.url || "/", "http://localhost").searchParams.get("category") || "alerts";
        const items = await gateway.list(category, staff);
        json(response, 200, { category, items });
        return;
      }
      if (request.method === "POST" && pathname === "/v1/miniapp/ack") {
        await gateway.requireLinkedStaff(telegram.id);
        const body = await readBody(request);
        if (typeof body.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.id)) {
          throw new MiniAppError(400, "INVALID_NOTIFICATION_ID");
        }
        const updated = await gateway.acknowledge(body.id, telegram.id);
        json(response, 200, { acknowledged: updated });
        return;
      }
      json(response, 404, { error: "NOT_FOUND" });
    } catch (error) {
      if (error instanceof MiniAppError) {
        json(response, error.status, { error: error.code });
      } else {
        // Avoid echoing transport errors, PII, credentials or upstream URLs to clients.
        console.error("miniapp.request_failed", { category: "internal" });
        json(response, 500, { error: "INTERNAL_ERROR" });
      }
    }
  });
}
