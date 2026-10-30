# Transactional email through Trigenys Notify

Implemented at the user's request to centralize Commerce Factory mail in Notify rather than add a product-specific SMTP sender. Email dispatch is **off by default**. Existing Telegram, WAHA, Meta and Mini App flows retain their configuration and authentication.

## Ownership and reuse

Commerce Factory verifies its Neon delivery webhook and renders its existing branded HTML/text. It submits a versioned request to Notify. Notify authenticates the product, pins its sender identity, claims a durable D1 receipt, and invokes the SMTP adapter. The configured transactional relay supplies authenticated SMTP; it does not create or redeem auth tokens. Neon remains the identity provider.

Reuse inspected at Notify `4f0140bb31566f3694350bad5e7ee5cc32888dee`: `dispatch.ts` per-product server authentication, `NotifyDatabase` D1 port, `whatsapp-receipts.ts` claim/fencing pattern, real SQLite migration tests and the workerd smoke. AppFactory was also inspected; there is no SMTP mailer there. SMTP requires different ambiguity handling from the existing WhatsApp lease: a sending/uncertain email is never automatically reclaimed.

Nodemailer 10.3.1 supplies SMTP and MIME composition. Its current maintainers document Cloudflare Workers support. Compared with Worker Mailer, it also supports the existing Node test setup and a real TLS SMTP fixture without a second runtime or relay. There is no hand-written SMTP protocol or MIME encoder.

## Private HTTP contract V1

`POST /v1/dispatch/{project}/email`, `Content-Type: application/json`, `x-notify-auth: <scoped product key>`.

```json
{
  "version": 1,
  "project": "commerce-factory",
  "id": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "occurredAt": "2026-10-29T12:00:00.000Z",
  "expiresAt": "2026-10-29T12:05:00.000Z",
  "recipient": "merchant@example.com",
  "message": {
    "subject": "Votre lien de connexion · Commerce Factory",
    "html": "<p>Fictional preview only</p>",
    "text": "Fictional preview only"
  }
}
```

The event ID is the SHA-256 fingerprint of the product's stable source delivery identity. Commerce includes its Neon endpoint, event type and UUID, so separate Auth branches cannot collide. `occurredAt`, `expiresAt` and content stay identical on every retry. IDs are 64 lowercase hex characters, recipient is one mailbox, subject has no CR/LF, the total body is capped at 64 KiB, and extra `from`, BCC or attachment fields are rejected. Events older than five minutes, more than one minute in the future or already expired are rejected; validity is capped at one day. Use this auth-delivery contract for short-lived transactional events, not delayed marketing campaigns.

The sender comes only from the server policy, never from the request. New products require their own key and opt-in policy. A Telegram/WhatsApp key is not an email key. Auth links are never passed into staff group routing.

An HTTP **202 with `accepted:true`, matching `project`, `channel:"email"` and `eventId`** means SMTP accepted the message. It does not prove inbox delivery, link redemption or a restored session. Invalid requests return 400/401/409/413/415; unavailable channels, SMTP or receipts return sanitized 503 responses. No provider body, recipient or credential is returned in an error.

## Durable receipts and failure handling

`backend/migrations/0004_transactional_email.sql` adds a table to the **existing Notify D1 database**. No additional database and no Commerce Factory migration are needed.

The ledger holds product, opaque event ID, HMAC-SHA-256 content fingerprint, claim token, state, attempt count and timestamps. It stores no recipients, mail bodies, OTPs, links or SMTP credentials. The keyed fingerprint prevents offline guessing of short OTP content from a copied ledger.

- First attempt atomically claims `(project,event_id)`. Concurrent requests cannot send twice.
- A recorded `accepted` receipt returns the prior acceptance without sending again.
- Reusing an ID with changed content/sender returns a conflict.
- Confirmed refusals or failures before DATA can retry, up to three attempts.
- Connection loss after DATA, unexpected transport errors or an abandoned sending claim remain unresolved and are **not** sent again automatically. The user can request a fresh auth link with a fresh event ID.
- A stable Message-ID helps trace a message but is not treated as SMTP idempotency.
- A failed receipt write after SMTP acceptance cannot release the claim for another send. SMTP cannot provide an exactly-once guarantee across a lost acknowledgement; this implementation favors preventing duplicate sends over silently retrying an uncertain transaction.
- Expired metadata is removed in batches of at most 200 by the Worker's existing five-minute scheduled handler, after expiry plus one day. Group cleanup/discovery runs independently.

The adapter uses immediate TLS on port 465, certificate/hostname verification, TLS 1.2 minimum, bounded connection/greeting/socket timeouts and a 4.5-second overall send deadline. Connections close on every result. Debug/transaction logging and file/URL MIME reads are disabled. SMTP password whitespace is preserved.

## Secure configuration

On `trigenys-notify-staging-api`, host defaults to `mail.spacemail.com`, port to `465`:

- `SMTP_USER` — provider SMTP identifier, bounded to 256 printable ASCII characters without whitespace. For Spacemail, use the actual parent mailbox address, not an alias login. For Resend, use the literal `resend`.
- `SMTP_PASSWORD` — **secret** for the configured provider. For Spacemail this is the mailbox password; for Resend it is a sending API key. Enter it directly in the platform secret store.
- `EMAIL_COMMERCE_FACTORY_INGEST_KEY` — **secret**, scoped solely to this product's email channel.
- `EMAIL_PROJECTS_JSON` — non-secret JSON policy, e.g. `{"commerce-factory":{"enabled":true,"from":"Commerce Factory <commercefactory@trigenys.com>"}}`.
- `EMAIL_DISPATCH_ENABLED` — `true` only for the verified rollout. Default is `false`.
- Optional `SMTP_HOST` and `SMTP_PORT`; this adapter deliberately requires implicit TLS on 465.

The generic key slot for another authorized project is `EMAIL_{PROJECT_WITH_UNDERSCORES_UPPERCASE}_INGEST_KEY`. Adding it does not rotate or expose other products' keys. Policies and keys stay server-side.

Commerce Factory needs only `NOTIFY_EMAIL_BASE_URL` and its secret `NOTIFY_EMAIL_INGEST_KEY`. It has no Resend key or SMTP password. Sender identities and provider credentials are managed centrally in Notify.

## Resend relay rollout

Resend works through the existing SMTP adapter: no additional SDK, consumer change or database is needed. Official settings verified 2026-10-30: `SMTP_HOST=smtp.resend.com`, `SMTP_PORT=465`, `SMTP_USER=resend`, and `SMTP_PASSWORD` containing a Resend API key.

1. In the existing Resend team, verify that the exact sender domain in `EMAIL_PROJECTS_JSON` is authorized. Prefer a dedicated sending-only key restricted to that domain; never reuse another application's full-access key.
2. Store the new key directly as `SMTP_PASSWORD` in Notify's platform secret store. Do not paste it into a conversation, repository, workflow input or build log. Only Notify needs it; Commerce Factory keeps its existing scoped ingest key.
3. Apply the host, port, username and password together after readiness is confirmed. Preserve every unrelated binding and the existing email sender policy. Do not change the active host while the old mailbox password remains selected.
4. Request fresh links only for authorized test mailboxes. Confirm SMTP acceptance and one durable receipt per event; inspect delivered headers, SPF/DKIM/DMARC, rendering and inbox/spam placement. Provider acceptance alone does not establish deliverability.
5. Keep Spacemail's receiving MX records and professional mailboxes. Add only the DNS records Resend requires for sending; existing SPF must remain a single valid record per hostname.
6. Production credentials and activation remain a separate rollout. For transport rollback, restore the former host and matching credentials together. If they are unavailable, disable the affected Neon delivery webhook first to restore built-in delivery; do not leave a configured webhook pointing at a disabled Notify channel.

The generic SMTP boundary retains its fixed TLS/hostname verification, deadline, sender pinning, D1 idempotency and conservative handling of uncertain DATA acknowledgements across providers. This does not add automatic provider fallback or blind retries.

References: https://resend.com/docs/send-with-smtp ; https://resend.com/docs/dashboard/api-keys/introduction .

## Staging activation and rollback

1. Pass both repositories' checks. Apply migration 0004 to existing D1 `f29535b5-3cea-4be9-87b5-c682bc7967bd` through the authorized resource control plane. Do not create another D1 database or put provisioning in routine `check`.
2. Deploy Notify, preserving its assets, D1 binding, crons, existing keys and WAHA/Meta flags. Deploy the Commerce client from its checked bundle. Keep email flags disabled during preparation.
3. Configure the per-product ingest key on both sides and the policy on Notify. Configure the two Spacemail secrets in Notify only. Confirm the sender alias is authorized by the mailbox.
4. Enable the Notify email channel and perform an owned-mailbox acceptance/receipt test. Then enable Commerce `AUTH_EMAIL_ENABLED`. Subscribe **only `send.magic_link`** on Commerce's existing staging Neon branch, using its existing webhook URL and **10-second per-attempt timeout**. The global Neon delivery budget remains 15 seconds.
5. Request a fresh link and confirm sender, content, receipt, click, session restoration and merchant destination. Never retain real magic-link URLs in evidence. Email OTPs remain with Neon until separately enabled and their default language checked.
6. Production is a separate rollout against production Notify resources and credentials; do not connect production auth silently to staging.

Rollback first disables the affected Neon webhook to restore built-in delivery. Disabling Notify while Neon still requires its delivery webhook would break that flow. The email-only flags/policies must not change WhatsApp, Meta or Telegram.

## Verification

Root tests use the real SQLite migrations for authorization, sender pinning, privacy, repeated/concurrent events, payload conflicts, safe retry cap, ambiguous acceptance, fencing, failed receipt writes and bounded cleanup. Backend tests use the real Nodemailer adapter and a local SMTP server with a trusted test certificate; they verify TLS, authentication, MIME text/HTML, rejection and cancellation. The workerd/D1 smoke exercises the actual bundled SMTP adapter against an unreachable fictional host, alongside the existing multigroup checks. These fixtures send no real messages.

Spacemail credentials are not configured by source changes. Real mailbox delivery and live Neon redemption remain unverified until secure activation.

## RAIDER

Reusable channel API and SMTP boundary; configurable project policy; atomic durable claims; existing D1 and cron; bounded, privacy-preserving delivery; opt-in adoption for existing consumers. This is an explicit extension for transactional email, not a replacement for Xeption's source outbox or its working Telegram sender.

References checked 2026-10-29: https://nodemailer.com/smtp ; https://nodemailer.com/extras/smtp-connection ; https://nodemailer.com/extras/mailcomposer ; https://developers.cloudflare.com/workers/runtime-apis/nodejs/tls/ ; https://www.spaceship.com/en-GB/knowledgebase/connect-spacemail-to-email-client/ ; https://neon.com/docs/auth/guides/webhooks .
