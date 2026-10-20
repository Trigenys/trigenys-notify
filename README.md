# Trigenys Notify

A reusable staff-notification and interaction service, bootstrapped by [Trigenys AppFactory](https://github.com/Trigenys/appfactory). Xeption is its first consuming application.

## Telegram Mini App (first implementation)

This repo now includes a mobile-first **Telegram Mini App** for the **existing Xeption staff bot**. The **staging UI and its Xeption delegated API are deployed** on Cloudflare; ERP ↔ Telegram linking and protected staff actions are being finalized separately.

- `GET /miniapp`: responsive Telegram interface (built-in static assets)
- `GET /v1/miniapp/public-config`: public Supabase URL and anon key only
- `GET /v1/miniapp/session`: Telegram HMAC identity + verified linked Xeption staff
- `POST /v1/miniapp/link`: attach a Telegram user to an authenticated Xeption staff member
- `GET /v1/miniapp/items?category=alerts|stock|images|trocs|marketplace`: role-aware and PII-minimized views
- `POST /v1/miniapp/ack`: audited acknowledgment (feature-flagged)
- `POST /v1/miniapp/troc-action`: guarded `contacted` or `refused` transitions
- `POST /v1/miniapp/marketplace-sold`: guarded active → sold state change

Direct mutations are **OFF** until the Xeption migration and staging security tests pass. Inventory updates and photo uploads remain in Xeption ERP.

The Mini App verifies Telegram's signed `initData` server-side and requires a one-to-one binding to a **current, real Xeption staff account**. A Telegram group member without Xeption staff permission cannot access the data.

## Run

Requires Node.js 24+.

```bash
npm install
npm run check
npm run dev
```

Copy and securely configure `.env.example`. Node does not automatically load the file for `npm run dev`; provide host environment variables (or use Node's `--env-file` when explicitly launching Node in local development). Never commit a bot token or Supabase service-role key.

Main references:

- [Reusable event contract, tenant policies and optional WAHA adapter](docs/reuse-and-channels.md)
- [Manually run live staging checks](.github/workflows/staging-smoke.yml) or use `npm run smoke:staging` (read-only).

- [Mini App security and staging runbook](docs/telegram-miniapp.md)
- [ADR-001 — Reuse the existing Xeption notification engine](docs/adr-001-xeption-reuse.md)
- [Xeption migration PR](https://github.com/EagleFox31/xeption237/pull/20)

## Why not a second bot?

Xeption already has Telegram sending, persistent `admin_notifications`, per-channel retries, de-duplication and scheduled relay. A parallel sender would duplicate messages and create split delivery histories. Trigenys Notify extends the existing bot with operational workflows, then extracts reusable shared contracts for other Trigenys products.

## Status

AppFactory project: provisioned. Mini App interface: deployed in Cloudflare staging. Xeption notification sending remains in the original Supabase relay. Reusable core contracts, tenants and optional Telegram/WAHA transport adapters are available **as library code only**, with no additional sender switched on. The ERP ↔ Telegram account-linking flow is a separate, ongoing change. The staging write flag remains disabled; this repository does not attempt to deploy SQL or bot credentials.
