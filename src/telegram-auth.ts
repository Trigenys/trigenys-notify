import { createHmac, timingSafeEqual } from "node:crypto";

export interface TelegramIdentity {
  id: string;
  displayName: string;
  authDate: number;
}

export class MiniAppError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

/** Validate the *raw* Telegram.WebApp.initData (never initDataUnsafe). */
export function verifyTelegramInitData(
  raw: string,
  botToken: string,
  nowSeconds = Math.floor(Date.now() / 1000),
  maxAgeSeconds = 3600
): TelegramIdentity {
  if (!raw || raw.length > 8192 || !botToken) throw new MiniAppError(401, "INVALID_TELEGRAM_SESSION");
  const params = new URLSearchParams(raw);
  const fields = [...params.entries()];
  if (fields.length < 3 || new Set(fields.map(([key]) => key)).size !== fields.length) {
    throw new MiniAppError(401, "INVALID_TELEGRAM_SESSION");
  }
  const hash = params.get("hash");
  const authDateText = params.get("auth_date");
  if (!hash || !/^[a-f0-9]{64}$/i.test(hash || "") ||
    !authDateText || !/^\d{10}$/.test(authDateText)) {
    throw new MiniAppError(401, "INVALID_TELEGRAM_SESSION");
  }
  const authDate = Number(authDateText);
  if (!Number.isSafeInteger(authDate) || authDate > nowSeconds + 60 ||
    nowSeconds - authDate > maxAgeSeconds) {
    throw new MiniAppError(401, "EXPIRED_TELEGRAM_SESSION");
  }
  // The hash field alone is excluded from bot-token HMAC validation.
  const checkString = fields.filter(([key]) => key !== "hash")
    .sort(([a], [b]) => a.localeCompare(b, "en"))
    .map(([key, value]) => key + "=" + value).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const calculated = createHmac("sha256", secret).update(checkString).digest();
  if (!timingSafeEqual(Buffer.from(hash, "hex"), calculated)) {
    throw new MiniAppError(401, "INVALID_TELEGRAM_SESSION");
  }
  let user: unknown;
  try { user = JSON.parse(params.get("user") || "null") as unknown; }
  catch { throw new MiniAppError(401, "INVALID_TELEGRAM_SESSION"); }
  if (!user || typeof user !== "object" || Array.isArray(user)) {
    throw new MiniAppError(401, "INVALID_TELEGRAM_SESSION");
  }
  const item = user as Record<string, unknown>;
  if (typeof item.id !== "number" || !Number.isSafeInteger(item.id) || item.id <= 0) {
    throw new MiniAppError(401, "INVALID_TELEGRAM_SESSION");
  }
  const firstName = typeof item.first_name === "string" ? item.first_name.slice(0, 60) : "";
  const lastName = typeof item.last_name === "string" ? item.last_name.slice(0, 60) : "";
  return { id: String(item.id), displayName: (firstName + " " + lastName).trim() || "Personnel", authDate };
}
