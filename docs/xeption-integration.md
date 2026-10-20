# Xeption integration contract

Xeption is the first consumer of Trigenys Notify, **not** part of its codebase.

## POST /v1/events

Use a project-scoped API key stored on the Xeption **backend** (never in frontend source).

```http
POST /v1/events
Content-Type: application/json
Authorization: Bearer <XE PTION_NOTIFIER_API_KEY>
```

Example JSON:

```json
{
  "id": "xeption-barter-123-created",
  "type": "barter.requested",
  "subject": "Troc iPhone 13 contre Galaxy S24",
  "details": {
    "Produit proposé": "iPhone 13",
    "Produit souhaité": "Samsung Galaxy S24",
    "Soulte": "65 000 FCFA",
    "Statut": "À examiner"
  },
  "url": "https://xeption.example/admin/barters/123"
}
```

Supported event types:
- `stock.low`: sent only when quantity crosses the configured threshold; reset when replenished
- `product.missing_images`: send a daily digest, not a push per product
- `barter.requested`: one message per new user proposal, with actionable details
- `marketplace.listing_created`: one message per new listing **pending moderation**

The Xeption backend owns the stock threshold, missing-image scan, marketplace state and links; Notify only transports messages.

### Telegram setup

1. Create a Telegram bot with BotFather and retain its token in server-side secrets.
2. Add it to a private staff group and grant the minimum rights needed to post.
3. Obtain the group's numeric chat ID and set `channels[].chatId`.
4. Configure `TELEGRAM_BOT_TOKEN` and `NOTIFY_PROJECTS_JSON` in the runtime.

### WhatsApp setup (optional)

WAHA requires a separately maintained WhatsApp Web session; use a **dedicated number** because unofficial automation can lead to account restriction. Set `WAHA_BASE_URL`, `WAHA_API_KEY`, a WhatsApp group JID ending in `@g.us`, and `provider: "waha"`.

### Delivery guarantees (V1 limitations)

- Delivery is synchronous; `200 delivered` means provider accepted a request, not that staff read it.
- Process-local duplicate suppression lasts 24 hours but is lost on restart/scale-out.
- A failed delivery returns `502`; retries can duplicate a message on a previously successful channel.
- Do not promise production reliability until a persistent outbox, retries and per-channel delivery tracking are implemented.
- Do not include unnecessary personal contact information in staff alerts; use protected links for sensitive details.
