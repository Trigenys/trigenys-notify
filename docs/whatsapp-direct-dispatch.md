# Individual WhatsApp dispatch (`whatsapp-direct`)

`POST /v1/dispatch/{project}/whatsapp-direct` sends one WhatsApp text message to an individual E.164 number through the WAHA session already operated by Notify. It exists for products that know who must be reached (a signer, an issuer, a customer) while Notify keeps the transport, the per-project authentication, the idempotency ledger and the rate limits. The route is **off by default**: the Worker flag and the project entry both have to be enabled.

Group routing (`/v1/dispatch/xeption/whatsapp`, approved D1 routes) and the generic email route are untouched. The route shares the WAHA text transport (`sendWahaText`) and the email helpers (`equalSecret`, `limitedJson`); nothing is duplicated.

## Contract V1

Headers: `Content-Type: application/json`, `x-notify-auth: <WHATSAPP_DIRECT_{PROJECT}_INGEST_KEY>`. The body is the email envelope with a phone number as recipient; the body is limited to 8 KiB.

```json
{
  "version": 1,
  "project": "trigenys-sign",
  "id": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  "occurredAt": "2026-11-09T12:00:00.000Z",
  "expiresAt": "2026-11-09T13:00:00.000Z",
  "recipient": "+237650000001",
  "message": {
    "text": "Un document attend votre signature : Contrat cadre 2026",
    "link": "https://sign.example.com/s/42",
    "linkLabel": "Signer"
  }
}
```

| Field | Rule |
| --- | --- |
| `version` | `1` |
| `project` | must equal the path project (`[a-z][a-z0-9-]{1,48}`) |
| `id` | 64 lowercase hex characters; the idempotency key, chosen by the product (hash of its own event) |
| `occurredAt` | ISO 8601, at most 5 minutes old, at most 1 minute in the future |
| `expiresAt` | after `occurredAt` and after now, at most 24 hours after `occurredAt` |
| `recipient` | E.164: `+` then 8 to 15 digits, first digit non-zero. Sent to WAHA as `{digits}@c.us`. Group ids and emails are refused |
| `message.text` | required, 1 to 3000 characters, no control characters |
| `message.link` | optional `https` URL, at most 1024 characters, no credentials; appended after the text |
| `message.linkLabel` | optional, at most 80 characters, one line, requires `link` |

Rendered text: `text`, blank line, `🔗 {linkLabel}\n{link}` (label omitted when absent). Unknown fields anywhere are refused.

### Responses

| Status | Body | Meaning |
| --- | --- | --- |
| 202 | `{"accepted":true,"project","channel":"whatsapp_direct","eventId"}` | WAHA accepted the message, or an identical event was already accepted (no second send) |
| 400 | `INVALID_WHATSAPP_EVENT` | envelope, recipient or message rejected |
| 401 | `UNAUTHORIZED` | key mismatch for this project and channel |
| 403 | `PROJECT_NOT_ALLOWED` | valid key, but the project is absent from `WHATSAPP_DIRECT_PROJECTS_JSON` |
| 409 | `EVENT_ID_REUSED` | same `id`, different content |
| 413 / 415 | `BODY_TOO_LARGE` / `JSON_REQUIRED` | transport guards |
| 429 | `{"error":"RATE_LIMITED","scope":"project"\|"recipient"}` + `retry-after: 60` | hourly limit reached; nothing is stored, the product retries later with the same `id` |
| 502 | `PROVIDER_REJECTED` | WAHA refused the message (for example a number without WhatsApp); replays return 502 without resending |
| 503 | `INGEST_NOT_CONFIGURED`, `WHATSAPP_DIRECT_NOT_CONFIGURED`, `CHANNEL_DISABLED` | Worker side not ready; nothing was sent |
| 503 | `PROVIDER_UNAVAILABLE`, `RATE_LIMITED`, `NETWORK_*`, `RECEIPT_UNAVAILABLE` | retryable: the product replays the same envelope; at most 3 attempts per event |
| 503 | `DELIVERY_UNRESOLVED` | retry budget exhausted or a send is in flight; an operator decides |
| 404 / 405 | | unknown project pattern or non-POST |

Acceptance by WAHA is not read confirmation. Replays are safe: identical content answers 202 without a second message.

### Rate limits

`limits.perHour` counts the project's receipts created in the last hour; `limits.perRecipientPerHour` counts those for the same number (keyed HMAC fingerprint). Limits are checked before any receipt is written, so a refused event consumes neither a receipt nor a retry attempt, and a retry of an already claimed event never counts against itself.

## Storage and logs

Migration `backend/migrations/0005_whatsapp_direct.sql` creates `notify_whatsapp_direct_deliveries` (project, event id, payload fingerprint, recipient fingerprint, state, claim token, attempts, timestamps). Phone numbers, texts, links and keys are never persisted; both fingerprints are HMAC-SHA256 keyed with the project ingest key. Expired receipts are purged by the existing cron.

Logs carry `notify.whatsapp_direct` with the project, the event id, the recipient masked to its last four digits (`***0001`) and the outcome. Neither the key nor the text is ever logged.

## Worker configuration

| Variable | Kind | Value |
| --- | --- | --- |
| `WHATSAPP_DIRECT_DISPATCH_ENABLED` | var | `"true"` to open the channel (default `"false"`) |
| `WHATSAPP_DIRECT_PROJECTS_JSON` | var | `{"trigenys-sign":{"enabled":true,"limits":{"perHour":200,"perRecipientPerHour":5}}}`; keys other than `enabled` and `limits` are refused, limits are mandatory |
| `WHATSAPP_DIRECT_{PROJECT}_INGEST_KEY` | secret | 32 to 256 characters, project name upper snake case (`trigenys-sign` → `TRIGENYS_SIGN`) |
| `WAHA_BASE_URL`, `WAHA_SESSION`, `WAHA_API_KEY` | existing | shared with group routing |
| `NOTIFY_DB` | existing D1 binding | migration `0005` must be applied |

```bash
wrangler secret put WHATSAPP_DIRECT_TRIGENYS_SIGN_INGEST_KEY --config backend/wrangler.production.jsonc
```

```bash
wrangler d1 migrations apply trigenys-notify-routing-staging --remote --config backend/wrangler.production.jsonc
```

Limits are hourly windows: `perHour: 50` and `perRecipientPerHour: 5` bound a day to roughly 200 messages per project and 20 per recipient at a steady pace while allowing short bursts.

Activation: apply the migration, set the secret, set `enabled: true` for the project in `WHATSAPP_DIRECT_PROJECTS_JSON`, then `WHATSAPP_DIRECT_DISPATCH_ENABLED` to `"true"`, and deploy. Rollback: set the flag back to `"false"`; the route answers `503 CHANNEL_DISABLED` and nothing is sent. Receipts remain valid and prevent duplicate sends after re-activation.

## Example

```bash
curl -sS -X POST "https://trigenys-notify-staging-api.lawrynnjennifer.workers.dev/v1/dispatch/trigenys-sign/whatsapp-direct" \
  -H "content-type: application/json" \
  -H "x-notify-auth: $WHATSAPP_DIRECT_TRIGENYS_SIGN_INGEST_KEY" \
  -d '{"version":1,"project":"trigenys-sign","id":"'"$(openssl rand -hex 32)"'",
       "occurredAt":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'","expiresAt":"'"$(date -u -d '+1 hour' +%Y-%m-%dT%H:%M:%SZ)"'",
       "recipient":"+237650000001",
       "message":{"text":"Un document attend votre signature.","link":"https://sign.example.com/s/42","linkLabel":"Signer"}}'
```

## Verification

- `npm test` at the repository root: `test/core/whatsapp-direct-dispatch.test.ts` covers authentication (401/403/503), E.164 validation and `@c.us` mapping, rendered text, idempotency (202 replay, 409 reuse), hourly limits per project and per recipient, WAHA error mapping (503 retryable, 502 final, attempt cap) and the absence of numbers, keys and text in logs and receipts.
- `npm run check` in `backend/`: typecheck, bundle dry run and the routing smoke, which applies every migration including `0005`.
