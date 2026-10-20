import { timingSafeEqual } from "node:crypto";

export const EVENT_LABELS = {
  "stock.low": "⚠️ Stock faible",
  "product.missing_images": "📷 Images manquantes",
  "barter.requested": "🔄 Nouvelle demande de troc",
  "marketplace.listing_created": "🛍️ Nouvelle annonce Marketplace"
} as const;

export type EventType = keyof typeof EVENT_LABELS;
export type Channel = { provider: "telegram" | "waha"; chatId: string; session?: string };
export type Project = { id: string; name: string; apiKey: string; channels: Channel[] };
export type Notification = {
  id: string;
  type: EventType;
  subject: string;
  details: Record<string, string | number | boolean>;
  url?: string;
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function loadProjects(raw: string | undefined): Project[] {
  if (!raw) return [];
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value)) throw new Error("NOTIFY_PROJECTS_JSON must be an array");
  const projects: Project[] = [];
  for (const item of value) {
    if (!record(item) || typeof item.id !== "string" || !/^[a-z0-9_-]{2,50}$/.test(item.id)
      || typeof item.name !== "string" || !item.name.trim() || typeof item.apiKey !== "string"
      || item.apiKey.length < 24 || !Array.isArray(item.channels) || item.channels.length === 0) {
      throw new Error("Invalid notification project configuration");
    }
    const channels: Channel[] = item.channels.map((channel: unknown) => {
      if (!record(channel) || (channel.provider !== "telegram" && channel.provider !== "waha")
        || typeof channel.chatId !== "string" || !channel.chatId.trim()
        || (channel.session !== undefined && typeof channel.session !== "string")) {
        throw new Error("Invalid notification channel");
      }
      return { provider: channel.provider, chatId: channel.chatId, session: (channel.session as string | undefined) };
    });
    if (projects.some(p => p.id === item.id || p.apiKey === item.apiKey)) {
      throw new Error("Duplicate notification project ID or API key");
    }
    projects.push({ id: item.id, name: item.name, apiKey: item.apiKey, channels });
  }
  return projects;
}

export function authorize(projects: Project[], authorization: string | undefined): Project | undefined {
  if (!authorization?.startsWith("Bearer ")) return undefined;
  const supplied = Buffer.from(authorization.slice(7), "utf8");
  return projects.find(project => {
    const expected = Buffer.from(project.apiKey, "utf8");
    return expected.length === supplied.length && timingSafeEqual(expected, supplied);
  });
}

export function parseNotification(input: unknown): Notification {
  if (!record(input) || typeof input.id !== "string" || !/^[a-zA-Z0-9._:-]{1,128}$/.test(input.id)
    || typeof input.type !== "string" || !Object.hasOwn(EVENT_LABELS, input.type)
    || typeof input.subject !== "string" || !input.subject.trim() || input.subject.length > 160
    || !record(input.details) || Object.keys(input.details).length > 15) {
    throw new Error("Invalid event payload");
  }
  const details: Notification["details"] = {};
  for (const [key, value] of Object.entries(input.details)) {
    if (!key || key.length > 40 || !/^[^\x00-\x1F]+$/.test(key) ||
      !["string", "number", "boolean"].includes(typeof value) ||
      (typeof value === "string" && value.length > 300) ||
      (typeof value === "number" && !Number.isFinite(value))) {
      throw new Error("Invalid event details");
    }
    details[key] = value as string | number | boolean;
  }
  let url: string | undefined;
  if (input.url !== undefined) {
    if (typeof input.url !== "string" || input.url.length > 1000) throw new Error("Invalid URL");
    try {
      const parsed = new URL(input.url);
      if (parsed.protocol !== "https:" || !parsed.hostname) throw new Error("Insecure URL");
      url = parsed.href;
    } catch { throw new Error("Invalid URL"); }
  }
  return {
    id: input.id,
    type: input.type as EventType,
    subject: input.subject.trim(),
    details,
    ...(url ? { url } : {})
  };
}

function clean(value: string): string {
  return value.replace(/[\x00-\x1F\x7F]/g, " ").trim();
}

export function formatNotification(project: Project, event: Notification): string {
  const lines = [
    "[" + clean(project.name) + "] " + EVENT_LABELS[event.type],
    clean(event.subject)
  ];
  for (const [key, value] of Object.entries(event.details)) {
    lines.push(clean(key) + " : " + clean(String(value)));
  }
  if (event.url) lines.push("Voir : " + event.url);
  return lines.join("\n").slice(0, 3900);
}

export async function sendChannel(channel: Channel, message: string): Promise<void> {
  let endpoint: string;
  let payload: object;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (channel.provider === "telegram") {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) throw new Error("Telegram is not configured");
    endpoint = "https://api.telegram.org/bot" + token + "/sendMessage";
    payload = { chat_id: channel.chatId, text: message, disable_web_page_preview: true };
  } else {
    const base = process.env.WAHA_BASE_URL;
    const key = process.env.WAHA_API_KEY;
    if (!base || !key) throw new Error("WAHA is not configured");
    endpoint = base.replace(/\/+$/, "") + "/api/sendText";
    headers["x-api-key"] = key;
    payload = { session: channel.session || "default", chatId: channel.chatId, text: message };
  }
  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error("Provider HTTP " + response.status);
  if (channel.provider === "telegram") {
    const body: unknown = await response.json();
    if (!record(body) || body.ok !== true) throw new Error("Telegram rejected the message");
  }
}
