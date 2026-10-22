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

## 2026-10-21 — Keep D1 provisioning out of routine Worker validation

- Impact: the approved multigroup fix passed CI but did not deploy. An AppFactory relaunch exposed `ROUTING_D1_API_HTTP_401` during the new D1 provisioning step.
- Cause: the routine Workers Builds credential can deploy the existing Worker but cannot administer D1. AppFactory distinguishes its Workers Builds credential from its existing resource-management credentials. A ChatGPT connector error had also been incorrectly treated as a reason to require a browser login before trying the canonical AppFactory/OIDC workflow.
- Resolution: initialize the dedicated D1 database and record the three migrations through the authorized resource control plane, commit its actual binding ID, and keep `check` limited to validation and a local Worker/D1 smoke test. Routine code deployment no longer attempts to create databases or change token permissions.
- Prevention: D1 provisioning is an explicit operator command, separate from normal builds. The canonical infrastructure workflow now prints AppFactory's failure message and missing-permission metadata. Retry that authorized workflow before escalating to interactive dashboard access.
- Build watch paths now cover `backend/**`, `src/**`, `web/**`, root package manifests and `.appfactory/**`; the unrelated Shopify template filter was removed. Shared core and web changes must also trigger a Notify deployment.

## 2026-10-22 — Validate copied SSH secrets before connecting

- Impact: the first configured VPS workflow stopped with an OpenSSH/libcrypto parsing error before opening a connection; Caddy was not changed.
- Cause: the private-key secret supplied to the job was not parseable. The exact clipboard damage is not visible to the operator; CRLF line endings are a possible cause.
- Prevention: normalize CRLF, require the complete OpenSSH boundaries, and validate both key files before connecting. Report only fixed diagnostic codes/instructions; never log the supplied credentials. A malformed secret must be replaced directly from the file on the VPS, without sending it through a conversation.

