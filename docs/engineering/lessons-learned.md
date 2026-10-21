# Engineering lessons learned

This file is the default RAIDER failure-memory location for this service.

Record meaningful failures and near misses with:

- context and impact;
- root cause;
- resolution;
- recurrence-prevention guardrail;
- generalized lesson when applicable.

Before risky work that resembles a known incident, search this file first.

## 2026-10-21 — Wrong WhatsApp destination and incomplete group discovery

- Impact: Xeption alerts went to the default TRIGENYS GROUP despite the account belonging to Xeption app test.
- Cause: no D1 binding in the deployed Worker; dispatch used the fallback as its primary destination. The discovery diagnostic assumed a list, whereas NOWEB returned an object keyed by group IDs. The original route schema also permitted only one group per project.
- Resolution: composite route keys, separate discovery and approval, an explicit fallback policy, and a staging migration for the owner-confirmed Xeption group. Provision and migrate D1 before deployment.
- Prevention: regression tests execute real SQLite migrations and cover keyed provider responses, pending approvals, cross-project isolation, fanout, concurrent dispatches and partial retries. Durable receipts skip groups that already accepted the event; recipient plans prevent replay into newly approved groups.
- Operational requirement: polling requires authenticated read access to the two WAHA group-list endpoints, or signed outgoing WAHA webhooks. A provider outage must not select the fallback.
- Runtime guardrail: the workerd smoke caught that Workers does not implement `redirect: 'error'`. Discovery uses `manual` and rejects non-2xx responses, so API keys never follow redirects. Node-only tests are insufficient for transport changes.

