#!/usr/bin/env node
/**
 * Read-only smoke test of the deployed Notify / Xeption Mini App gateway.
 * Intentionally never uses a real Telegram signature or writes Xeption data.
 */
const base=(process.env.NOTIFY_STAGING_URL ||
  "https://trigenys-notify-staging-api.lawrynnjennifer.workers.dev").replace(/\/+$/,"");
if(!/^https:\/\//.test(base))throw new Error("Staging URL must use HTTPS");

async function probe(path,expected) {
  const res=await fetch(base+path,{
    redirect:"manual",cache:"no-store",
    signal:AbortSignal.timeout(12000),
    headers:{"accept":"application/json, text/html;q=0.9"}
  });
  if(res.status!==expected)throw new Error(path+": expected "+expected+", received "+res.status);
  if(expected>=200 && expected<300 && res.headers.get("cache-control")!=="no-store")
    throw new Error(path+": missing no-store header");
  return res;
}

const health=await (await probe("/health",200)).json();
if(health.status!=="ok" || health.service!=="trigenys-notify")
  throw new Error("Invalid health response");
console.log("OK health: 200");

const config=await (await probe("/v1/miniapp/public-config",200)).json();
if(typeof config.supabaseUrl!=="string" || !config.supabaseUrl.startsWith("https://") ||
   typeof config.supabaseAnonKey!=="string" || !config.supabaseAnonKey ||
   typeof config.writesEnabled!=="boolean")
  throw new Error("Invalid public config");
if(config.writesEnabled!==false)
  throw new Error("Staging write flag must remain OFF");
console.log("OK public config: 200, writes disabled");

const anonymous=await (await probe("/v1/miniapp/session",401)).json();
if(typeof anonymous.error!=="string" || !anonymous.error)
  throw new Error("Anonymous Telegram session did not return an error");
console.log("OK unsigned session: denied (401)");

const app=await probe("/miniapp",200);
const html=await app.text();
if(!html.includes("Centre de gestion") || !html.includes("telegram-web-app.js"))
  throw new Error("Mini App HTML missing required assets");
if(!app.headers.get("content-security-policy"))
  throw new Error("Mini App CSP missing");
console.log("OK Telegram Mini App HTML: 200");

await probe("/miniapp/app.js",200);
await probe("/miniapp/styles.css",200);
console.log("OK static JS and CSS: 200");
console.log("All staging smoke checks passed.");
