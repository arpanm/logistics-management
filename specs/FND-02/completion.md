# FND-02 UX remediation completion evidence

**Status:** Product remediation implemented locally; new password-recovery tests are Implemented / Not Run.

## Delivered

- User details, assignments, effective-access preview, reports, events, alerts, and permission decisions render as labelled fields/tables/cards rather than raw JSON.
- Tenant-root identity administrators can rotate, copy, and revoke a pending activation link. Rotation is serialized per membership, increments the membership version, revokes older links, returns plaintext once with `Cache-Control: no-store`, and persists only token hashes/redacted replay data.
- Administrative controls use server-evaluated tenant-root action flags; read-only directory users do not trigger admin-only role/scope requests.
- “Access Proof” was removed from normal navigation and reframed as an explained, non-mutating Permission tester.
- “Security” was renamed to **Activity & audit**, with typed searchable access/audit/security tables and separate actionable security alerts.
- Activated users can sign in again with the password created during invitation acceptance. The generic forgot-password boundary records a provider-delivery request without enumerating identities; provider-free deployments use the copy-once tenant-admin link for a single-tenant identity. Shared cross-tenant identities require a configured verified-delivery provider. Reset completion revokes all sessions and reset tokens.

## Verification

| Evidence                     | Status                | Result                                                                                                                                                                  |
| ---------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backend FND-02 integration   | Passing               | 14/14, including concurrent activation rotation, stale-version loser, old-token invalidation and token-free idempotency replay                                          |
| Backend/frontend type checks | Passing               | `pnpm --filter @logistics/backend typecheck`; `pnpm --filter @logistics/frontend typecheck`                                                                             |
| Local deployment and health  | Passing               | `make deploy-local`; `make health`; shared `shared-postgres` only                                                                                                       |
| `E2E-FND02-07`               | Passing               | Structured user administration and one-time activation-link copy                                                                                                        |
| `E2E-FND02-08`               | Passing               | Explained permission test creates no business mutation                                                                                                                  |
| `E2E-FND02-09`               | Passing               | Searchable Activity & audit tables, scoped real APIs, separate alert actions, no raw JSON                                                                               |
| `FND02-AUTH-REC-U01`         | Implemented / Not Run | Password-recovery request, confirmation, and administrator input boundaries                                                                                             |
| `FND02-AUTH-REC-001..003`    | Implemented / Not Run | Generic/rate-limited request, migration/RLS evidence, copy-once cross-tenant denial, single-use reset and session revocation                                            |
| `E2E-FND02-10`               | Implemented / Not Run | Client activation, repeat login, generic request, administrator copy-once reset, fragment scrubbing, credential rotation, replay denial, and shared-identity protection |

## Explicit follow-ups

- Profile-field mutation with verified-identity rules, richer session/MFA/history detail, and server-paginated directory/report filtering are tracked in `TODO.md` and are not claimed complete here.
- The synthetic permission diagnostic remains directly routable for current automated acceptance fixtures but is absent from standard navigation; production-only route gating remains a hardening follow-up.
