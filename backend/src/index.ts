import { verifyTelegramInitData, MiniAppError } from "../../src/telegram-auth.js";
import miniappHtml from "../../web/miniapp.html";
import { XeptionGateway, settingsFromEnv } from "../../src/xeption-gateway.js";
import { dispatchXeptionWhatsApp } from "../../src/core/dispatch.js";

type AssetFetcher = { fetch(request: Request): Promise<Response> };
interface Env {
  ASSETS: AssetFetcher;
  MINIAPP_ENABLED?: string;
  MINIAPP_WRITES_ENABLED?: string;
  TELEGRAM_BOT_TOKEN?: string;
  XEPTION_SUPABASE_URL?: string;
  XEPTION_SUPABASE_ANON_KEY?: string;
  XEPTION_SUPABASE_SERVICE_ROLE_KEY?: string;
  XEPTION_SITE_URL?: string;
  XEPTION_MINIAPP_EDGE_URL?: string;
  WAHA_DISPATCH_ENABLED?: string;
  XEPTION_NOTIFY_INGEST_KEY?: string;
  WAHA_BASE_URL?: string;
  WAHA_API_KEY?: string;
  WAHA_SESSION?: string;
  WAHA_STAFF_GROUP_ID?: string;
}

function reply(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store", "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer"
  }});
}

async function bodyJson(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new MiniAppError(415, "JSON_REQUIRED");
  }
  if (Number(request.headers.get("content-length") || 0) > 8192) {
    throw new MiniAppError(413, "BODY_TOO_LARGE");
  }
  const raw = await request.text();
  if (raw.length > 8192) throw new MiniAppError(413, "BODY_TOO_LARGE");
  try {
    const decoded: unknown = JSON.parse(raw);
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw Error("object required");
    return decoded as Record<string, unknown>;
  } catch { throw new MiniAppError(400, "INVALID_JSON"); }
}

function staticPath(path: string): string | null {
  if (path === "/miniapp" || path === "/miniapp/") return "/miniapp.html";
  if (path === "/miniapp/app.js") return "/app.js";
  if (path === "/miniapp/styles.css") return "/styles.css";
  if (path === "/miniapp/logo.png") return "/logo.png";
  return null;
}

const UUID_RE = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;

export async function handleRequest(request: Request, env: Env, fetchImpl: typeof fetch = fetch): Promise<Response> {
  try {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === "GET" && path === "/health") {
      return reply({status:"ok",service:"trigenys-notify",version:"0.1.0"});
    }
    const staticFile = staticPath(path);
    if (request.method === "GET" && staticFile) {
      const assetUrl = new URL(staticFile, url.origin);
      const served = staticFile === "/miniapp.html"
        ? new Response(miniappHtml, {status:200,headers:{"content-type":"text/html; charset=utf-8"}})
        : await env.ASSETS.fetch(new Request(assetUrl, request));
      const headers = new Headers(served.headers);
      headers.set("cache-control", "no-store");
      headers.set("x-content-type-options", "nosniff");
      headers.set("referrer-policy", "no-referrer");
      headers.set("content-security-policy",
        "default-src 'none'; script-src 'self' https://telegram.org; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; " +
        "connect-src 'self' " +
        (env.XEPTION_SUPABASE_URL && /^https:\/\//.test(env.XEPTION_SUPABASE_URL)
          ? new URL(env.XEPTION_SUPABASE_URL).origin : "") +
        "; img-src 'self' data: https://res.cloudinary.com; frame-ancestors https://web.telegram.org https://webk.telegram.org https://webz.telegram.org; base-uri 'none'; form-action 'self'");
      return new Response(served.body, { status: served.status, headers });
    }
    // Standalone server-to-server product notifications. Never touch the
    // Telegram Mini App or its Xeption-specific authentication.
    if (path === "/v1/dispatch/xeption/whatsapp") {
      return dispatchXeptionWhatsApp(request,env,fetchImpl);
    }
    if (!path.startsWith("/v1/miniapp/")) return reply({error:"NOT_FOUND"},404);
    // Optional delegated adapter: Xeption verifies Telegram initData and executes
    // Xeption operations with secrets it already owns. Notify keeps the web UI.
    if (env.XEPTION_MINIAPP_EDGE_URL) {
      const base = new URL(env.XEPTION_MINIAPP_EDGE_URL);
      if (base.protocol !== "https:" || !/^[a-z0-9-]+\.supabase\.co$/.test(base.hostname) ||
          !base.pathname.endsWith("/functions/v1/telegram-miniapp-api")) {
        throw new MiniAppError(503, "INVALID_XEPTION_EDGE_TARGET");
      }
      const resource = path.slice("/v1/miniapp/".length);
      const methods: Record<string, string> = {
        "public-config":"GET", session:"GET", items:"GET",
        link:"POST", ack:"POST", "troc-action":"POST",
        "marketplace-sold":"POST",
        restock:"POST"
      };
      if (!Object.hasOwn(methods,resource) || methods[resource] !== request.method) {
        return reply({error:"NOT_FOUND"},404);
      }
      const upstream = new URL(base.href.replace(/\/+$/, "") + "/" + resource);
      if (resource === "items") upstream.searchParams.set("category",url.searchParams.get("category") || "alerts");
      let payload: string | undefined;
      if (request.method === "POST") {
        if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
          throw new MiniAppError(415,"JSON_REQUIRED");
        }
        payload = await request.text();
        if (payload.length > 8192) throw new MiniAppError(413,"BODY_TOO_LARGE");
      }
      const upstreamResponse = await fetchImpl(upstream.href, {
        method: request.method,
        headers: {
          "x-telegram-init-data":request.headers.get("x-telegram-init-data") || "",
          ...(payload !== undefined ? {"content-type":"application/json"} : {})
        },
        body:payload,
        signal:AbortSignal.timeout(12000)
      });
      const h = new Headers({
        "content-type":"application/json; charset=utf-8",
        "cache-control":"no-store",
        "x-content-type-options":"nosniff",
        "referrer-policy":"no-referrer"
      });
      return new Response(upstreamResponse.body,{status:upstreamResponse.status,headers:h});
    }
    const settings = settingsFromEnv(env as unknown as NodeJS.ProcessEnv);
    const gateway = new XeptionGateway(settings, fetchImpl);
    if (!gateway.isConfigured()) throw new MiniAppError(503,"MINIAPP_NOT_CONFIGURED");

    if (request.method === "GET" && path === "/v1/miniapp/public-config") {
      return reply({
        supabaseUrl:settings.supabaseUrl, supabaseAnonKey:settings.supabaseAnonKey,
        xeptionSiteUrl:settings.xeptionSiteUrl, writesEnabled:settings.writesEnabled
      });
    }

    const initData = request.headers.get("x-telegram-init-data") || "";
    const telegram = verifyTelegramInitData(initData,settings.botToken);

    if (request.method === "POST" && path === "/v1/miniapp/link") {
      const input = await bodyJson(request);
      if (typeof input.xeptionAccessToken !== "string") throw new MiniAppError(400,"XEPTION_TOKEN_REQUIRED");
      const staff = await gateway.linkTelegram(telegram.id,input.xeptionAccessToken);
      return reply({linked:true,staff:{name:staff.name,role:staff.role},telegramName:telegram.displayName});
    }
    if (request.method === "GET" && path === "/v1/miniapp/session") {
      try {
        const staff = await gateway.requireLinkedStaff(telegram.id);
        return reply({linked:true,staff:{name:staff.name,role:staff.role},telegramName:telegram.displayName});
      } catch(error) {
        if (error instanceof MiniAppError && error.code === "LINK_XEPTION_ACCOUNT") {
          return reply({linked:false,telegramName:telegram.displayName});
        }
        throw error;
      }
    }
    if (request.method === "GET" && path === "/v1/miniapp/items") {
      const staff = await gateway.requireLinkedStaff(telegram.id);
      const category = url.searchParams.get("category") || "alerts";
      return reply({category,items:await gateway.list(category,staff)});
    }
    if (request.method === "POST" && path === "/v1/miniapp/ack") {
      const staff = await gateway.requireLinkedStaff(telegram.id);
      const input = await bodyJson(request);
      if (typeof input.id !== "string" || !UUID_RE.test(input.id)) throw new MiniAppError(400,"INVALID_NOTIFICATION_ID");
      return reply({acknowledged:await gateway.acknowledge(input.id,staff.telegramUserId)});
    }
    if (request.method === "POST" && path === "/v1/miniapp/troc-action") {
      const staff = await gateway.requireLinkedStaff(telegram.id);
      const input = await bodyJson(request);
      if (typeof input.id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(input.id) ||
        (input.action !== "contacted" && input.action !== "refused") ||
        (input.reason !== undefined && (typeof input.reason !== "string" || input.reason.length > 300))) {
        throw new MiniAppError(400,"INVALID_TROC_ACTION");
      }
      if (input.action === "refused" && (typeof input.reason !== "string" || input.reason.trim().length < 5)) {
        throw new MiniAppError(400,"REJECTION_REASON_REQUIRED");
      }
      return reply(await gateway.trocAction(input.id,input.action,input.reason as string | undefined,staff));
    }
    if (request.method === "POST" && path === "/v1/miniapp/marketplace-sold") {
      const staff = await gateway.requireLinkedStaff(telegram.id);
      const input = await bodyJson(request);
      if (typeof input.id !== "string" || !UUID_RE.test(input.id)) throw new MiniAppError(400,"INVALID_LISTING_ID");
      return reply({changed:await gateway.markMarketplaceSold(input.id,staff)});
    }
    return reply({error:"NOT_FOUND"},404);
  } catch(error) {
    if (error instanceof MiniAppError) return reply({error:error.code},error.status);
    console.error("miniapp.worker_failed");
    return reply({error:"INTERNAL_ERROR"},500);
  }
}
// Cloudflare calls fetch(request, env, executionContext). Never pass the
// ExecutionContext as handleRequest's optional fetch implementation.
export default {
  fetch(request: Request, env: Env, _context: ExecutionContext): Promise<Response> {
    return handleRequest(request, env);
  }
} satisfies ExportedHandler<Env>;
