import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import { MiniAppError, verifyTelegramInitData } from "../src/telegram-auth.js";

const token = "123456:TEST_SECRET_NOT_REAL";
const now = 1792490400;

function signedInitData(fields: Record<string, string> = {}): string {
  const props: Record<string, string> = {
    auth_date: String(now),
    query_id: "AA-test",
    user: JSON.stringify({ id: 279058397, first_name: "Staff", last_name: "Xeption" }),
    ...fields
  };
  const check = Object.entries(props).sort(([a], [b]) => a.localeCompare(b, "en"))
    .map(([key, value]) => key + "=" + value).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const hash = createHmac("sha256", secret).update(check).digest("hex");
  return new URLSearchParams({ ...props, hash }).toString();
}

test("valid Telegram HMAC returns only identity, not trusted roles", () => {
  assert.deepEqual(verifyTelegramInitData(signedInitData(), token, now), {
    id: "279058397", displayName: "Staff Xeption", authDate: now
  });
});

test("rejects tamper, missing token, incorrect bot and duplicate parameters", () => {
  const valid = signedInitData();
  assert.throws(() => verifyTelegramInitData(valid.replace("Staff", "Admin"), token, now), MiniAppError);
  assert.throws(() => verifyTelegramInitData(valid, "wrong-token", now), MiniAppError);
  assert.throws(() => verifyTelegramInitData(valid + "&auth_date=" + now, token, now), MiniAppError);
  assert.throws(() => verifyTelegramInitData(valid.replace(/hash=[^&]+/, ""), token, now), MiniAppError);
});

test("rejects expired/future Telegram timestamps", () => {
  assert.throws(() => verifyTelegramInitData(signedInitData({auth_date:String(now - 3601)}), token, now), MiniAppError);
  assert.throws(() => verifyTelegramInitData(signedInitData({auth_date:String(now + 61)}), token, now), MiniAppError);
});

test("rejects a signed session without a Telegram user", () => {
  const signed = signedInitData({user:"{}"});
  assert.throws(() => verifyTelegramInitData(signed, token, now), MiniAppError);
});

export { signedInitData, token, now };
