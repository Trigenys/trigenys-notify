# ADR-001 — Reuse the existing Xeption Telegram notification pipeline

Status: accepted for design, integration pending validation  
Date: 2026-10-20

## Discovery

The original notification API prototype was created before inspecting Xeption's actual repository. It duplicates existing Xeption work and is **not** the implementation to deploy. Draft PR #1 was closed.

Existing Xeption implementation: [EagleFox31/xeption237](https://github.com/EagleFox31/xeption237).

| Source | Reusable capability |
| --- | --- |
| `docs/engineering/NOTIFICATIONS.md` | Event matrix, dedup policy and operational behavior |
| `supabase/functions/_shared/staffNotify.ts` | Channel interface, message formats, link routing |
| `supabase/functions/_shared/staffNotifyChannels/telegram.ts` | Telegram Bot API adapter, HTML escaping, buttons |
| `supabase/functions/notify-staff/index.ts` | Delivery relay, environment-based channels |
| `supabase/migrations/20261020_002_staff_notification_deliveries.sql` | Persisted channel-delivery state and claim/retry scheduling |
| `supabase/migrations/20261020_003_staff_troc_detail_and_missing_images.sql` | Troc details and no-image notifications |

## Architecture boundary

1. **Xeption remains the source of truth** for stock, marketplace listings, barter requests, inventory updates, staff roles and notifications already persisted in `admin_notifications`.
2. **Trigenys Notify becomes reusable channel/interaction infrastructure**, not a second Xeption event producer. One provider send path per `(project, event, channel)`. Migrate only via an explicit feature flag and verified cutover.
3. Extract/generalize transport contracts and formatting. Normalize event keys through a versioned envelope, e.g. Xeption `stock_low` → Notify `stock.low`. Do not change Xeption DB triggers merely to rename message types.
4. Telegram bot already configured in Xeption should be reused. Do not create a second Telegram BotFather bot or expose its existing token.
5. **Mini App** attaches to the existing Xeption bot and provides authorized staff interactions. It reads/writes Xeption through server-side adapters; it never directly executes user-supplied SQL or exposes Supabase service-role keys.

## Mini App V1 user journeys

- Stock: list low-stock items, inspect product, perform authorized inventory updates with audit trail.
- Missing images: list items with absent media, link/upload product images using backend media authorization.
- Smart Troc: review offer and photos, accept/refuse when permitted by actual Xeption business state machine.
- Marketplace: review pending listing and approve/reject when permitted; include moderation history.

Read-only views first, mutations only after permissions, auditing and action idempotency tests pass.

## Telegram constraints

Telegram Mini Apps are web applications associated with a bot. Bot group notifications can contain a **direct HTTPS/t.me deep link** to the bot's Mini App. Do not assume inline-keyboard `web_app` buttons work in group chats: the Bot API limits those to private chats. Launch in the user's private chat, the bot menu, or use official direct Mini App links.

Authenticate using Telegram `initData` verified server-side using the bot token, including `auth_date` expiry. Then require explicit Telegram-user-ID ↔ Xeption-staff-account binding and server-side role validation on **every** protected operation. Never trust `initDataUnsafe`, client role claims or mere group membership.

## Operational/security notes

- Current Xeption `notification_deliveries` stores retry state per notification/channel and is more durable than the process-local dedup in the discarded prototype. Provider acceptance is not proof of user reading.
- Existing Xeption `target_role` is not currently filtered inside `claim_notification_deliveries`. Do not include sensitive client numbers in a common Telegram staff group; audit scope and redact push notifications.
- Check deployment of Edge Functions, cron and secrets independently; source code alone does not confirm live delivery.
- Do not send production alerts from Trigenys Notify until the old sender path is coordinated and disabled for the migrated events.
- WhatsApp WAHA remains optional and independent from Mini App authentication; unofficial WhatsApp Web operation has restriction risk.

## Sequence

1. Validate current Xeption deployed messaging and credentials **without logging secrets**.
2. Implement Mini App frontend + signed Telegram identity + staff account binding in Trigenys Notify.
3. Add read-only Xeption adapters and test against staging.
4. Add audited mutations and error/idempotency handling.
5. Extract channel infrastructure incrementally only if multi-project reuse demands it. Maintain one canonical outbox per event stream and no double-send.
