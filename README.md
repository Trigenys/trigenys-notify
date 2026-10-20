# Trigenys Notify

Reusable internal alerts API for Trigenys applications. Provisioned by [AppFactory](https://github.com/Trigenys/appfactory) with GitHub Project automation and CI.

**First consumer:** Xeption 237 — low stock, products without images, incoming barter requests and new marketplace listings.

## Scope

- Node.js 24 / TypeScript, no runtime framework needed for the V1
- `POST /v1/events` authenticated per project using a server-side Bearer token
- Telegram Bot API (primary) and optional WAHA WhatsApp group adapter
- Event-specific formatting, input validation and transient duplicate suppression
- `GET /health` readiness endpoint
- No Telegram Mini App, AI, customer conversations or admin dashboard in V1

## Local run

```bash
cp .env.example .env
npm install
npm run check
npm run dev
```

Node does **not** automatically load `.env` for this service. Use `node --env-file=.env --experimental-strip-types src/index.ts` or your host's secret/env configuration. Never commit credentials.

Configure `NOTIFY_PROJECTS_JSON` as a JSON array of project objects:

```json
[
  {
    "id": "xeption",
    "name": "Xeption",
    "apiKey": "LONG_RANDOM_PROJECT_SCOPED_SECRET",
    "channels": [
      { "provider": "telegram", "chatId": "-1001234567890" }
    ]
  }
]
```

Connect an additional WAHA group with `{ "provider": "waha", "chatId": "YOUR_GROUP@g.us", "session": "default" }` and set `WAHA_BASE_URL` + `WAHA_API_KEY`. Telegram requires `TELEGRAM_BOT_TOKEN`. All credentials stay server-side.

A backend client can submit:

```bash
curl -X POST http://localhost:3000/v1/events \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer YOUR_PROJECT_KEY' \
  -d '{"id":"stock-redmi-15-threshold-20261020","type":"stock.low","subject":"Redmi Note 15","details":{"Restant":2,"Seuil":3}}'
```

See [Xeption integration contract](docs/xeption-integration.md) for event rules and exact limits.

## Roadmap

1. Connect Telegram bot and Xeption backend in a staging environment.
2. Add durable PostgreSQL outbox, retries, per-channel status and metrics.
3. Add WAHA to a private test group; never use a personal WhatsApp number.
4. Support additional Trigenys products via separate credentials and channel routes.

**V1 is a functional prototype, not a durable delivery system:** it requires secrets, hosting and a private staff chat before notifications can be sent. The process-local idempotency cache is not persistent.
