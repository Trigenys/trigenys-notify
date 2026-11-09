# Engineering lessons learned

This file is the default RAIDER failure-memory location for this service.

Record meaningful failures and near misses with:

- context and impact;
- root cause;
- resolution;
- recurrence-prevention guardrail;
- generalized lesson when applicable.

Before risky work that resembles a known incident, search this file first.

## 2026-10-30 — Select an existing SMTP secret instead of renaming live bindings

- Near miss: the operator securely uploaded RESEND_API_KEY, while Notify expected SMTP_PASSWORD. A settings rename was rejected because the destination name already existed; a version-clone attempt was rejected for missing static asset data. Both requests failed validation and left the deployed Worker unchanged.
- Resolution: add a generic SMTP_PASSWORD_SECRET selector whose default remains SMTP_PASSWORD. Configure Resend's host, username and selected secret name together after the checked code deploys. Existing credentials, static assets and other channel bindings stay in place.
- Prevention: named-secret tests cover the existing D1 receipt boundary and fail closed for invalid names, missing values and wrong types. A selected secret never falls back to an unrelated legacy credential. Do not request a key recopy or manipulate assets merely to change which already-stored credential a transport uses.
- Operator handoff: show the copy-and-store step immediately after key creation, before CLI instructions that require its value. Confirm the secret name in the platform without reading or logging the secret.

## 2026-10-30 — Keep SMTP identities independent of mailbox addresses

- Near miss: the generic email channel validated SMTP_USER as an email address. Resend's documented SMTP identifier is the literal resend, so changing only the relay settings would fail closed before delivery.
- Resolution: accept bounded printable ASCII SMTP identifiers without whitespace or control characters. Keep the sender mailbox validation, implicit TLS on 465, certificate checks and password handling unchanged.
- Prevention: a Resend-style configuration test exercises dispatch, pinned sender and durable duplicate suppression; invalid identifiers must fail before a receipt is created or transport is called.
- Rollout guardrail: verify the sender domain and provision the matching provider key before switching the active SMTP host. Treat host, username and password as one operational configuration.

## 2026-10-29 — Preserve SMTP hostname for Workers TLS

- Impact: authorized staging magic links reached Notify but all SMTP attempts failed before authentication with a generic ESOCKET error.
- Root cause: Nodemailer pre-resolved the SMTP hostname and opened TLS to the resulting IP. A credential-free deployed probe showed a 220 greeting with both node:tls and native Workers sockets using the hostname, while node:tls to the resolved IP failed with a proxy address denial.
- Resolution: pre-open certificate-verified TLS with the configured hostname and pass its secured socket through Nodemailer's public connection option. Abort and connection deadlines own the socket throughout setup and delivery.
- Prevention: exercise the actual pre-opened TLS adapter against a trusted local SMTP fixture, including hostname mismatch rejection, and retain the workerd failure-path smoke. Keep raw SMTP errors private; bounded phase and allowlisted codes are sufficient operational diagnostics.
- General lesson: a generic provider error does not establish bad credentials. Isolate transport without credentials before changing account secrets or weakening TLS.

## 2026-10-29 — Centralize transactional email and preserve uncertain SMTP receipts

- Near miss: adapting a mailer inside each consuming product would duplicate provider credentials, retries and delivery state despite the existing Notify service.
- Cause: reusing another product's provider client without first assigning the channel to the shared notification service.
- Resolution: products retain their templates and source identity; Notify owns authenticated SMTP and its existing D1 receipt boundary. No product-specific SMTP dependency or new database is needed.
- Prevention: inspect registered shared-service ownership before adding a provider SDK. A lost SMTP DATA acknowledgement is not a safe retry; unresolved/sending claims remain blocked instead of being reclaimed on lease expiry. Tests cover receipt-write failure after acceptance and a real workerd SMTP failure path.
- Configuration guardrail: email activation flags/policies are runtime-owned with absent values failing closed. Do not commit false/default policy bindings that would overwrite an operator's activation on every later deployment with keep_vars.

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

## 2026-10-22 — Preserve useful business facts and stable event identity

- Impact: WhatsApp alerts named neither the product nor the remaining stock, although Xeption's persisted notification already contained both and sometimes the staff actor.
- Cause: the source envelope discarded every content field and the receiver generated generic text. The producer also rebuilt its event time from the current clock on each attempt, which conflicts with the receiver's immutable payload hash after partial delivery.
- Resolution: optional typed business facts, reconstructed from the persisted notification's known fields; batch-read the original creation time for WhatsApp. Keep client/contact fragments out and preserve the current Telegram sender, event subscriptions and outbox.
- Prevention: source/receiver contract tests, privacy and size checks, a product-model/year case that must not be mistaken for a phone number, stable retry payload tests and a real workerd/D1 smoke asserting the rendered facts. Do not infer a previous stock value from today's inventory.

## 2026-11-09 — A new-order alert must say who to call and what to prepare

- Impact: a real web order reached the staff group as « Livraison : delivery » only; amount and city were lost.
- Cause: the privacy rule excluded every customer field, and the producer's text parsing failed on a
  locale-formatted total (`90,000 FCFA`) and a city with parentheses and commas.
- Resolution: type-scoped order contact facts (ADR-002) rendered by Notify; the producer sends a typed
  order snapshot instead of parsing human text.
- Prevention: tests for rendering, strict validation, dropping contact fields on other types and the
  4096-byte limit with a 10-item order. Generalized lesson: a privacy default needs a documented,
  type-scoped exception path, and producers should send typed values, not parsed display strings.
