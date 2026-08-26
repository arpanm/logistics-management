# INT-01 — AWS SES owner invitation delivery

**Status:** Implemented
**Feature source:** `FEATURES.md` INT-01 and FND-01 owner-invitation acceptance
**Owner:** Primary agent

## Problem and outcome

Tenant provisioning creates a durable owner invitation, but the provider-free adapter cannot deliver it. Production must submit each valid owner activation email to Amazon SES from `mukh.bad@gmail.com` without storing or logging a plaintext activation token.

## In scope

- Amazon SES v2 in `eu-north-1`, using the EC2 instance profile and a configured verified sender.
- A bounded in-process backend dispatcher over the existing PostgreSQL invitation queue; no new service or container.
- Authenticated encryption for retryable token material, lifecycle-safe state transitions, bounded retries, safe failure codes, and operator recovery.
- New tenant owner invitations and audited replacement/reissue invitations.

## Out of scope

- SMS, WhatsApp, general access invitations, password-reset email, inbound bounce/complaint processing, marketing mail, and a dedicated worker deployment.
- Claiming inbox receipt: `DELIVERED` means accepted by SES, not delivered to the recipient mailbox.

## Dependencies and assumptions

| Item | State/decision | Evidence |
| ---- | -------------- | -------- |
| SES sender | `mukh.bad@gmail.com` selected; AWS verification pending | User decision, 2026-08-27 |
| SES account | Account `997979359169` is in the `eu-north-1` sandbox | AWS SES account dashboard |
| Arbitrary recipients | Requires SES production access; sandbox permits only verified recipients/simulator | AWS SES account dashboard and SES documentation |
| Credentials | EC2 instance profile; no static AWS key | Existing AWS deployment model |
| Encryption | AEAD envelope using the configured production encryption key; plaintext never persists | FND-01 token secrecy invariant |

## Actors, permissions, and scopes

| Actor/capability | Allowed scope | Sensitive fields/actions | Denied behavior |
| ---------------- | ------------- | ------------------------ | --------------- |
| Platform Admin | Provision and reissue owner invitation; inspect safe delivery status | One-time manual replacement URL; audit reason | Cannot read persisted plaintext token or tenant business data |
| Backend dispatcher | Lease and deliver eligible invitation attempts | Decrypt token only in process memory; call SES | Cannot send inactive, accepted, revoked, or expired invitations |
| Tenant owner | Receive and redeem their invitation | Activation token and chosen password | Cannot enumerate invitations or other tenants |

## UX flow

### Primary flow

1. Platform Admin creates an active tenant.
2. Provisioning commits one invitation, outbox event, and delivery attempt atomically.
3. The backend leases the attempt, decrypts the stable token in memory, and asks SES to send text and HTML email with the public HTTPS activation URL.
4. SES acceptance records the provider message ID, marks the attempt/invitation delivered, and processes the matching outbox event.
5. The owner opens the link, sets a password, activates, and can later sign in normally.

### Validation, loading, empty, error, retry, and stale states

Missing/invalid production configuration fails closed. Transient provider errors use bounded backoff with the same token. Terminal provider rejection remains truthful and actionable. Legacy attempts without encrypted token material require audited reissue. Inactive, expired, revoked, and accepted invitations are never sent. Reactivation must not falsely mark an unsent invitation delivered.

### Responsive and accessibility behavior

Existing tenant detail retains semantic queued/delivered/failed labels and a keyboard-accessible replacement-link action. Provider details and token material are never rendered.

## Data model and migration

Delivery attempts store an authenticated encrypted token envelope and safe provider evidence needed for retries. The migration is forward-safe and nullable for legacy rows. Provisioning/reissue writes `token_hash` plus the envelope atomically. Success, expiry, revoke, or acceptance erases encrypted material when no retry is required.

The queue is leased with PostgreSQL row locking and a lease timeout. Network I/O occurs outside the database transaction; acknowledgement is conditional on still owning the lease and the invitation remaining eligible.

## Domain rules and calculations

- Retries reuse the same active token; reissue rotates the token and invalidates the former link.
- A provisioning/idempotency replay creates no additional logical invitation or delivery request.
- SES acceptance is not exactly-once inbox delivery; rare ambiguous retries may duplicate the same harmless activation link.
- Store UTC timestamps. Email states the UTC expiry and uses the tenant timezone where available.
- Backoff and maximum attempts are configuration-bounded; safe error codes contain no provider payload or recipient data.

## API, events, and jobs

| Interface/event/job | Input | Output/effect | Auth/idempotency/failure behavior |
| ------------------- | ----- | ------------- | --------------------------------- |
| Tenant provision | Valid tenant and owner | Invitation, encrypted delivery attempt, outbox event | Platform Admin; existing idempotency key contract |
| Owner reissue | Expected version, reason | Rotated token and requeued attempt | Platform Admin; audited and idempotent |
| SES dispatcher | Eligible leased attempts | SES message submission and reconciled states | In-process only; bounded lease/retry |
| Manual worker run | Platform Admin request | Processes bounded queues | Existing protected diagnostic path remains |

## Reports and alerts

Safe invitation state, attempt count, next availability, and normalized failure code remain observable. Terminal/legacy failure creates or updates a deduplicated platform alert. Provider message ID may be stored as evidence but not exposed across tenant boundaries.

## Audit, observability, and security

No plaintext token, full destination, AWS credential, raw SES error, or message body appears in PostgreSQL outbox/audit, logs, metrics, API replay responses, or test artifacts. Tenant HTML is escaped. Sender and subject cannot be overridden by tenant input. IAM permits only SES sending from the verified identity.

## Lightweight acceptance notes

| Acceptance criterion | Design section | Planned test IDs |
| -------------------- | -------------- | ---------------- |
| One active-tenant invitation is eventually submitted once logically to SES | UX flow; domain rules | `INT01-SES-I-001/002/004`, `E2E-INT01-SES-01` |
| Text/HTML mail contains safe tenant context, expiry, and one HTTPS activation URL | Security | `INT01-SES-U-002`, `SES-SMOKE-001` |
| SES acceptance reconciles attempt, invitation, outbox, evidence, and audit | Data model; reports | `INT01-SES-I-002`, `INT01-SES-R-001` |
| Retry and terminal failure remain truthful without leaking secrets | Error states; security | `INT01-SES-U-003/004`, `INT01-SES-I-003/005` |
| Inactive/expired/revoked/accepted invitations never send | Domain rules | `INT01-SES-I-006`, `E2E-INT01-SES-03` |
| Authorization and tenant isolation protect delivery metadata | Actors | `INT01-SES-A-001/002`, `E2E-INT01-SES-04` |

## Open decisions

| Decision | Safe default | Owner/impact |
| -------- | ------------ | ------------ |
| SES production access | Remain sandboxed and send only to verified recipients until AWS approves | AWS account owner; arbitrary tenant mail is blocked |
| Domain-aligned sender | Use the verified Gmail address temporarily | Product owner; weaker branding/deliverability than a verified domain |
| Bounce/complaint feedback | Do not claim mailbox delivery; defer feedback pipeline | INT-01 follow-up |

## Readiness

- [x] Intended outcome and material rules are clear
- [x] Dependencies and affected interfaces are identified
- [x] Planned automated coverage is listed
