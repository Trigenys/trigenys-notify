# Telegram Mini App — Xeption staff

Status: implementation in draft PR; **not deployed**. Uses the existing Xeption bot, not a second bot.

## What has been implemented

- Signed and time-bounded \`Telegram.WebApp.initData\` (HMAC-SHA256 server-side, 1h TTL).
- Explicit per-user binding to Xeption's Supabase Auth account.
- Current staff role refreshed from Xeption for each request.
- Tabs for unread alerts, low stock, products with missing images, trocs, and Marketplace. Troc read model uses live Xeption schema fields `trade_in_value_cash`, `trade_in_value` and `target_product_name` (not `offer_cash`/`offer_credit`).
- Notification acknowledgement (team-shared), Smart Troc `accepted -> contacted` / refusal with mandatory reason, and Marketplace `active -> sold`, all audited by Xeption SQL RPCs and **OFF by default**.
- Direct links back to Xeption admin for changes not yet implemented in Mini App.

**This does not currently edit product stock, approve marketplace listings, or transition trocs.** That requires reusing Xeption's state machines, role rules, stock RPCs, and audit trail rather than direct service-role table updates. Marketplace listings currently default to \`active\`, not \`pending\`.

## Staging rollout (secrets never committed)

1. Review & deploy Xeption migration \`20261020_004_telegram_staff_miniapp.sql\` via Xeption's migration delivery process. Verify \`telegram_staff_links\` RLS (service role only), Auth binding, audit RPC permissions, and staff-role restrictions.
2. Deploy Trigenys Notify with Node 24, working directory at project root (static files are served from \`web/\`), HTTPS reverse proxy, restricted logs, and configured server-side variables from \`.env.example\`.
3. Provide **the same existing Telegram bot token** already used by the Xeption notification sender. Do not migrate or duplicate Xeption's outgoing messages.
4. Set \`MINIAPP_ENABLED=true\` only after migration and hosting verification. Keep \`MINIAPP_WRITES_ENABLED=false\` until acknowledgment RPC has passed tests in staging.
5. Configure \`https://YOUR_NOTIFY_DOMAIN/miniapp\` for the existing Telegram bot through [BotFather](https://t.me/BotFather) (Main Mini App or menu button).
6. Launch from a **private chat with the bot or official \`t.me/<bot>/<app>\` direct Mini App link**. Group-chat notification messages can link to the Mini App; inline-keyboard \`web_app\` buttons are private-chat only. Configure bot UI separately from the service, after confirming its username.
7. Staff first opens the Mini App inside Telegram, logs in with the same credentials they use for Xeption, then gets paired to their numeric Telegram user ID. Credentials go from the browser **directly to Xeption's Supabase Auth**; the Mini App gateway receives only a short-lived access token and never stores it.
8. Test unlinked / revoked / vendeur / responsable / direction / super_admin, concurrent acknowledgments, alert source mappings, no customer PII in group pushes, and bot token rotation.

## Security / operational notes

- **Never use \`initDataUnsafe\` for authentication**, nor group membership as an authorization source.
- Supabase service-role key must remain ONLY in the Notify backend's secret store.
- \`telegram_staff_links\` is one-to-one; an already paired account requires administrator revocation before reassignment.
- The linking route is intended behind an HTTPS server with reverse-proxy request throttling, origin controls, and a WAF. Add per-user and IP rate limits prior to broad public exposure.
- Read APIs expose a limited allowlist of fields; customer phone/email/PII is excluded from the Telegram UI.
- \`MINIAPP_WRITES_ENABLED\` is disabled by default and should not be activated just because the schema exists.
- If a Telegram auth session expires, staff closes and reopens the Mini App (a new signed \`initData\` is required).
- **The existing Xeption Telegram notification service is unchanged.** Avoid double-sending events.

Sources: https://core.telegram.org/bots/webapps, https://github.com/EagleFox31/xeption237/blob/main/docs/engineering/NOTIFICATIONS.md
