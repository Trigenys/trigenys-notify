# Generic WhatsApp group dispatch

`POST /v1/dispatch/{project}/whatsapp` lets any authorized product post a short message to **its own declared WhatsApp groups** through WAHA. It reuses the envelope and authentication of the [generic email route](transactional-email.md) and the WAHA adapter and D1 receipts of the [multigroup routing](waha-group-routing.md). No new database, migration, provider or secret type.

Product-specific routes keep precedence and their own contract: `/v1/dispatch/xeption/whatsapp` and `/v1/dispatch/atelier/whatsapp`. The generic route refuses the `xeption` and `atelier` project names (404).

## Private HTTP contract V1

`Content-Type: application/json`, `x-notify-auth: <project WhatsApp key>`, body ≤ 8 KiB.

```json
{
  "version": 1,
  "project": "trigenys-studio",
  "id": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "occurredAt": "2026-11-09T12:00:00.000Z",
  "expiresAt": "2026-11-09T13:00:00.000Z",
  "message": {
    "text": "Nouvelle tâche assignée : Maquette accueil",
    "link": "https://studio.example.com/tasks/42",
    "linkLabel": "Ouvrir la tâche"
  }
}
```

- `id`: 64 lowercase hex characters, stable across retries (e.g. SHA-256 of the product's source event identity). Same id with different content → `409 EVENT_ID_REUSED`.
- `occurredAt` at most 5 minutes old and 1 minute in the future; `expiresAt` in the future, after `occurredAt`, at most one day later.
- `message.text`: 1–3000 characters, line breaks allowed, other control characters refused.
- `message.link` (optional): `https` URL whose origin is listed in the project's `allowedLinkOrigins`, otherwise `400 LINK_ORIGIN_DENIED`. `linkLabel` (optional, ≤ 80 characters, one line) requires `link`.
- **No destination field.** Any extra field (`chatId`, `recipient`, phone number…) is refused (`400 INVALID_WHATSAPP_EVENT`).

Rendered WhatsApp text: `text`, then, when a link is present, a blank line, `🔗 <linkLabel>` and the URL. Link previews are disabled.

`202 {"accepted":true,"project","channel":"whatsapp_waha","eventId","recipients","acceptedRecipients"}` means WAHA accepted the message for every planned group. It does not prove that members read it. Other answers: `400/401/404/405/409/413/415`, `502` for a final provider refusal, `503` (`CHANNEL_DISABLED`, `GROUP_ROUTE_UNASSIGNED`, `WHATSAPP_NOT_CONFIGURED`, `INGEST_NOT_CONFIGURED`, provider or registry unavailable) when the caller may retry later with the **same** envelope. Errors never contain keys, group ids, provider bodies or message content.

## Destination allowlist

The only destinations are the groups declared for the project in the non-secret, reviewed `WHATSAPP_PROJECTS_JSON` var (`backend/wrangler.production.jsonc`):

```json
{"trigenys-studio":{"enabled":true,"groups":["120363000000000001@g.us"],"allowedLinkOrigins":["https://studio.example.com"]}}
```

- `groups`: up to 8 `…@g.us` ids, as strings (session = `WAHA_SESSION`) or `{"session","groupId"}`. Individual numbers (`@c.us`, `+237…`) are refused: a malformed entry disables the project (`503 WHATSAPP_NOT_CONFIGURED`), it is never partially applied.
- `enabled` must be `true`; the global `WAHA_DISPATCH_ENABLED=true` kill switch also applies. An empty `groups` list answers `503 GROUP_ROUTE_UNASSIGNED` without sending.
- The recipient list is frozen per event in D1 (`notify_whatsapp_events`). A retry only resends to groups that have not accepted yet, never to a group added since; a group removed from the policy since is skipped.

## Keys

One secret per project and channel: `WHATSAPP_{PROJECT_UPPER_SNAKE}_INGEST_KEY` (32–256 characters), e.g. `WHATSAPP_TRIGENYS_STUDIO_INGEST_KEY`. It is distinct from the project's email key: an email key never authorizes a WhatsApp message, and one project's key never posts for another. Notify stores only a keyed HMAC fingerprint of the event; no message text, link or key is written to D1 or logs.

## Trigenys Studio activation

The repository declares `trigenys-studio` **disabled** with no group, so merging this change sends nothing.

1. The owner creates the WhatsApp group **« Studio Comm »** and adds the WAHA session account (`trigenys-test` on staging) to it.
2. Read its id from the existing discovery (`GET /v1/whatsapp/groups`, admin key) — no VPS or Caddy change is needed, discovery is already open.
3. Put a freshly generated key in Notify's secret store as `WHATSAPP_TRIGENYS_STUDIO_INGEST_KEY`, and the same value in Studio's secret store. Never in a repository, chat or log.
4. In a reviewed PR, set the `trigenys-studio` entry of `WHATSAPP_PROJECTS_JSON` to `enabled:true`, the group id and Studio's public web origin in `allowedLinkOrigins`.
5. Test with one fictional event from Studio; confirm one message in « Studio Comm » and one `accepted` receipt.

Rollback: set `enabled:false` (or remove the group) in `WHATSAPP_PROJECTS_JSON`. Other products, Xeption, Atelier and email are untouched.

## Verification

`test/core/whatsapp-dispatch.test.ts` runs against the real D1 migrations (SQLite): declared-group-only delivery, rendering, idempotent and partial retries, frozen recipients, per-project/per-channel auth, reserved names, opt-in, invalid allowlists, envelope/freshness/link-origin validation, body limits and absence of leaks. `backend/scripts/routing-smoke.mjs` exercises the bundled Worker in workerd with D1: generic route to the declared group only, idempotent retry, Xeption and email routes unchanged. No real message is sent by the tests.
