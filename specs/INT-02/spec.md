# INT-02 — Conversational operations

**Status:** Implemented — external provider activation remains pending
**Test status:** Implemented / Not Run
**Depends on:** FND-02, DAT-01, GOV-01, INT-01, canonical Operations/Finance services

## Outcome

Authorized users can describe registered data-entry, status, approval, report, comment, import and document operations in normal English through authenticated in-app chat or a verified WhatsApp identity. The platform converts a supported write into a typed proposal, previews the exact action, requires confirmation, and executes only a registered tenant-scoped handler. Permission-scoped reference searches, status reports and operational attention summaries are read-only and execute immediately.

The language parser is untrusted. It never chooses an actor, tenant, capability, SQL statement, URL, API method, or arbitrary service method. The implementation uses a versioned closed command registry and a deterministic English extractor; a future model adapter must return the same strict schema and receives no authorization authority.

## Implemented scope

- Responsive authenticated `/app/assistant` workspace with thread history, safe-text messages, attachments, clarification, proposal, confirmation, cancellation, execution, and actionable error states.
- Server-derived in-app identity from the current session, active membership, roles, capabilities, scopes, tenant, and MFA assurance.
- WhatsApp link challenge created while authenticated; sender binding becomes trusted only after a signed provider webhook delivers the one-time code from that number.
- Signed and deduplicated Meta-compatible WhatsApp webhook for text, image and document input, plus transactional replies. Unknown, revoked, ambiguous, or multi-tenant senders fail closed without enumeration.
- English intent/entity extraction into an allow-listed command schema. Missing or ambiguous data produces a clarification rather than a guessed mutation.
- Typed proposals with normalized values, expected versions where applicable, risk class, expiry, and one explicit confirmation target. Reference search is tenant/scope filtered; zero or multiple matches clarify rather than guess.
- Idempotent execution through existing domain/application services with authorization and state rechecked immediately before execution.
- Bounded PostgreSQL-backed attachment staging. CSV/XLSX is routed through DAT-01 preview and confirmation-gated commit. PDF/JPEG/PNG creates GOV-01 document/version metadata but remains quarantined with `PENDING` scan state until a malware scanner is configured.
- PostgreSQL-backed outbound WhatsApp delivery leases, attempts, retry/dead-letter state, explicit proactive consent, tenant-timezone quiet hours, unsubscribe/unlink, and approved-template alert delivery.
- Immutable/audited message, confirmation, execution, denial, and provider-event evidence without logging raw phone numbers, secrets, or file/message contents.
- No Redis, external queue, object-store container, or separate worker deployment.

## Identity and authorization

1. In-app chat derives the actor only from `logistics_session`; mutations require the existing CSRF/origin checks.
2. WhatsApp verifies the provider signature before parsing, deduplication, identity lookup, or media retrieval. A stored address HMAC locates a verified binding; raw numbers are not used as tenant keys.
3. A global user may have multiple memberships. The conversation must be bound to one explicitly eligible tenant/membership; the system never chooses the first tenant or trusts free-text tenant names.
4. Membership status, authorization versions, role capabilities, resource scope, field masking, segregation of duties, target state, and optimistic version are checked when proposing and again when executing.
5. Privileged access/configuration actions, credential/MFA changes, high-value financial posting, reversals, and tenant-configured step-up actions cannot execute solely from WhatsApp.

## Processing flow

1. Persist and deduplicate the inbound message before interpretation.
2. Normalize English text and attachment descriptors as untrusted input.
3. Extract an intent code and fields, then validate against the registered strict schema.
4. Resolve references through capability- and scope-filtered application searches. Zero or multiple matches produce safe choices/clarification.
5. Normalize tenant-local dates to UTC, money to exact minor-unit strings, quantities with explicit units, mobile values to E.164, and enums to configured canonical codes.
6. Produce a human-readable proposal with target, material before/after fields, attachments, warnings, approval effects, and expiry.
7. Require explicit confirmation for creates, updates, transitions, imports, approval decisions, financial actions, reversals, and destructive actions. `Yes` applies only when exactly one active proposal exists.
8. Re-authorize and execute the registry handler using a server-derived idempotency key. A duplicate returns the original safe result; changed input with the same key conflicts.
9. Return canonical reference/status or a safe correction path and correlation ID. Never report success without committed canonical evidence.

## Data model

- Channel bindings and one-time link challenges.
- Tenant-bound conversation threads and immutable inbound/outbound messages.
- Attachment metadata/content reference, checksum, media type, size, scan state, and import/document linkage.
- Versioned proposals containing strict canonical payload, resolved references, expected versions, preview, risk, state, and expiry.
- Immutable confirmations and executions with command code, idempotency hash, result/error summary, correlation ID, and timestamps.
- Globally deduplicated provider receipts containing hashes/minimal routing evidence rather than full webhook payloads.
- Reuse canonical audit events, idempotency records, approval instances/decisions, governed documents, import jobs, and delivery/outbox tables.

Every tenant-owned table has a non-null tenant key, tenant-leading indexes, composite tenant foreign keys where applicable, and forced RLS. Raw content is excluded from ordinary logs, metrics, errors, audit payloads, and exports.

## APIs

- `GET /api/v1/conversations/capabilities`
- `GET/POST /api/v1/conversations/threads`
- `GET /api/v1/conversations/threads/:threadId`
- `POST /api/v1/conversations/threads/:threadId/messages`
- `POST /api/v1/conversations/proposals/:proposalId/confirm`
- `POST /api/v1/conversations/proposals/:proposalId/cancel`
- `POST /api/v1/conversations/whatsapp/link-challenges`
- `GET /api/v1/conversations/whatsapp/status`
- `PATCH /api/v1/conversations/whatsapp/preferences`
- `POST /api/v1/conversations/whatsapp/unlink`
- `GET /api/v1/conversations/whatsapp/deliveries`
- `GET/POST /api/v1/webhooks/whatsapp`

## Acceptance criteria

1. Browser identity/tenant is session-derived and WhatsApp identity requires signed-message proof plus an active verified binding.
2. Unsupported, low-confidence, missing, or ambiguous input produces clarification and no mutation.
3. Parser output must match one registered command schema; arbitrary commands, URLs, SQL, IDs, and capabilities are rejected.
4. Human references are searched only inside the actor's effective tenant/scope. Zero or multiple matches cannot produce a mutation.
5. Material actions show a precise proposal and require confirmation; changes invalidate the old proposal.
6. Authorization, MFA assurance, segregation, target state, and record version are rechecked immediately before execution.
7. Duplicate chat messages, webhooks, confirmations, and worker retries create one logical business effect.
8. CSV/XLSX produces a DAT-01 validation preview before commit; documents preserve checksum, classification, scan state, target, and uploader.
9. Approval decisions recheck pending state, role, expiry, optimistic version and maker-checker segregation inside the confirmation transaction.
10. Revoked access, stale proposals, provider/model outage, corrupt files, command failures, and retries remain safe and auditable.
11. The chat workspace is keyboard accessible, mobile responsive, safe-text-only, and exposes loading, clarification, confirmation, success, failure, and correlation states.
12. Transactional WhatsApp replies do not silently opt users into proactive alerts.

## External activation and deferred scope

- Hindi/Hinglish and selected Indic-language interpretation stays disabled until an evaluated corpus, thresholds and model/provider policy are approved. A few deterministic Hinglish aliases are convenience parsing, not claimed language support.
- Browser/mobile push requires a selected provider, subscription/token retention policy and consent contract. Existing in-app alerts and approved-template WhatsApp alerts do not imply push activation.
- Financial reversals are not exposed as generic status commands; they require a dedicated compensating-entry handler.
- Provider credentials, production retention, permitted WhatsApp risk classes, real malware scanning, WhatsApp business-number approval, and model-provider selection remain deployment/product decisions. Adapters stay disabled until explicitly configured.
