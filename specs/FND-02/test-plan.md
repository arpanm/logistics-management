# FND-02 — Test Plan

**Plan status:** Approved
**Overall test status:** Implemented — consolidated Playwright execution pending
**Related spec:** `specs/FND-02/spec.md`

## Purpose and risks

This plan verifies identity administration, centralized capability and scope evaluation, invitation and session lifecycle, MFA policy hooks, portal boundaries, field masking, security auditing, and access-review reporting. It deliberately uses neutral authorization resources instead of introducing organization, client, vendor, allocation, trip, or payment domain implementations owned by later features.

Principal risks are:

1. A role name or hidden UI control could be mistaken for server authorization.
2. Multiple roles could broaden access beyond the union of explicitly granted capabilities and matching positive scopes.
3. Region, client, vendor, location, or dynamically assigned-trip scope could be omitted from a detail, mutation, approval, report, or export query.
4. A known foreign UUID could reveal record existence through status, message, timing, audit detail, aggregate, or CSV content.
5. Removed scope, suspension, or session reset could leave an already issued session authorized.
6. Effective-permission preview could disagree with the policy used by create, read, update, export, approve, or administer endpoints.
7. Masking could protect the UI but leak sensitive values in JSON, CSV, audit snapshots, reports, alerts, logs, or portal shells.
8. Invitation replay, concurrent administration, or retries could create duplicate identities, memberships, grants, alerts, or audit events.
9. MFA policy hooks could allow a required-but-unverified user to enter the tenant, or lock a user out without a safe recovery state.
10. Reports and alerts could be incomplete, double counted, or expose another tenant's actors and security activity.

## Fixtures and environments

All automated tests use `logistics_test` on the central `shared-postgres` container, UTC persistence, a fixed clock of `2026-08-24T12:00:00Z`, and supported API/test-fixture endpoints enabled only outside production. No arbitrary sleeps, external identity provider, email/SMS delivery, downstream business module, or production data is required.

### Tenant and identity fixtures

| Fixture | Configuration |
|---|---|
| Tenant A (`FND02-A`) | `Asia/Kolkata`, `INR`; MFA required for privileged roles; regions North/South, branches N1/S1, clients Alpha/Beta, locations A1/B1, vendors Red/Blue |
| Tenant B (`FND02-B`) | `Asia/Dhaka`, `BDT`; MFA optional; identifiers intentionally resemble Tenant A identifiers to expose missing tenant predicates |
| Tenant A Owner | Tenant Owner; complete tenant root scope; verified password identity and MFA |
| Regional Manager | `REGIONAL_MANAGER`; North region read/create/update/export, no South scope and no approval/administer capability |
| KAM | `KEY_ACCOUNT_MANAGER`; Alpha client read/create/update/export, no Beta scope |
| Vendor Owner | `VENDOR_OWNER`; Red vendor read/update for allocations/trips and read for payments; no internal margin or unrestricted export permission |
| Driver | `DRIVER`; dynamic access only to currently assigned trip actions; verified mobile identity fixture |
| Client Viewer | `CLIENT_VIEWER`; Alpha client read-only portal capability; no internal margin, unrelated party, mutation, approval, or unrestricted export capability |
| Multi-role User | KAM plus Finance Executive; union of the roles' explicit capabilities, constrained by matching positive grants; central policy blocks still win |
| Suspended User | Former active MIS Executive with a persisted session to exercise suspension/session-attempt alerts |
| Tenant B User | Active Tenant B Regional Manager with analogous codes and different UUIDs |

Emails, mobiles, employee codes, invitation tokens, session tokens, MFA challenges, and idempotency keys are deterministic test values derived from the test ID. Secrets are stored/asserted only as hashes; evidence and failure output must redact them.

### Neutral scoped authorization resources

The fixture factory creates tenant-owned `scoped authorization resource` records representing `REGION_CASE`, `CLIENT_CASE`, `ALLOCATION`, `TRIP`, and `PAYMENT`. Each record has a stable UUID and code, tenant, legal-entity, region, branch, client, location, vendor, optional assigned-driver relationship, state, optimistic `version`, ordinary display fields, and sensitive fields (`pan`, `gstin`, `bankAccount`, `mobile`, `commercialRateMinor`, `paymentAmountMinor`, `internalMarginMinor`). These records exist solely to execute FND-02 policy and masking contracts. They are not logistics masters or transactions and must not gain module-specific behavior.

Create paired in-scope and out-of-scope records for every dimension in Tenant A, plus known-ID equivalents in Tenant B. Resource factories also create an unassigned trip, a reassigned trip, and a resource matching one scope dimension but failing another so conjunctive dimension checks are observable.

### Determinism and cleanup

- Every test uses a unique fixture namespace and transaction-safe cleanup or idempotent reset endpoint.
- Authentication and alert windows use the fixed clock; dormant-account boundaries use exact instants immediately before, at, and after the configured threshold.
- Parallel tests never share invitation, session, resource, or idempotency keys.
- RLS tests connect as the application role, set server-derived tenant context, and enumerate every new tenant-bearing table/view rather than sampling one table.
- Playwright setup uses supported APIs for fixtures, performs the behavior under test through UI, and asserts material server/database effects through supported read APIs.

## Authorization oracle

An operation is allowed only when the membership and user are active, authentication/MFA policy is satisfied, and at least one active role assignment contains both the requested capability and a positive typed scope grant matching the resource. Role assignments are additive, but a capability from one assignment cannot borrow a scope grant from another. Tenant root is the universal scope for that tenant only. More-specific grant dimensions are conjunctive; separate complete assignment/grant decisions are additive. Absence of capability or matching grant is a deny. No user-authored negative grants exist; non-overridable central policy blocks (including portal restrictions and sensitive-data rules) win over all role unions. Assigned-trip access is evaluated from the current assignment relation on every request. The same oracle must drive preview and server enforcement.

## Acceptance-to-test matrix

| Test ID | Acceptance/risk | Layer | Preconditions | Action | Expected result | Status | Evidence |
|---|---|---|---|---|---|---|---|
| FND02-U-001 | Central capability evaluation and multi-role union/deny rules | Unit | Active single- and multi-role memberships | Evaluate each action with capability present/absent and policy block present/absent | Active roles union only explicit capabilities; absent capability denies; policy blocks cannot be overridden | Planned | Pending implementation |
| FND02-U-002 | Typed and hierarchical positive scope evaluation | Unit | Tenant root and legal-entity/region/branch/client/location/vendor grants | Evaluate exact, ancestor, unrelated, multi-dimensional, expired, suspended, and cross-tenant matches | Only an active grant whose full typed constraint matches authorizes; tenant root never crosses tenant | Planned | Pending implementation |
| FND02-U-003 | Regional Manager and KAM boundaries | Unit | North/South and Alpha/Beta resources | Evaluate read/create/update/export/approve for both actors | Regional Manager is limited to North; KAM is limited to Alpha; capability gaps still deny in-scope actions | Planned | Pending implementation |
| FND02-U-004 | Vendor, Driver, and Client Viewer portal rules | Unit | Red/Blue vendor records, assigned/unassigned trips, Alpha/Beta client records | Evaluate portal actions and reassignment | Vendor sees Red-owned records only; Driver sees current assigned actions only; Client Viewer sees Alpha read-only | Planned | Pending implementation |
| FND02-U-005 | Sensitive-field masking | Unit | Every sensitive field and permission combination | Serialize detail/list/export/report/audit views | Explicit field capability reveals only permitted fields; otherwise stable masked/null representation contains no recoverable source value | Planned | Pending implementation |
| FND02-U-006 | Effective preview uses production policy inputs | Unit | Representative resources and all six operations | Compare preview decision/reasons with enforcement oracle | Allow/deny and safe reason codes are identical for create/read/update/export/approve/administer | Planned | Pending implementation |
| FND02-U-007 | Invitation and authentication validation | Unit | Email/mobile/auth-method/MFA policy matrices | Validate valid and malformed combinations, expiry, reuse, weak password and challenge state | Valid combinations accepted; invalid combinations return field errors and no mutation | Planned | Pending implementation |
| FND02-U-008 | Role-appropriate landing/work queue | Unit/component | Each baseline role and mixed-role user | Resolve navigation capabilities and portal shell | Landing page is capability-derived, contains only allowed queues/actions, and remains server-protected | Planned | Pending implementation |
| FND02-M-001 | Forward-safe upgrade and clean migration | Migration | FND-01 database with representative active sessions/data; clean database | Apply FND-02 migration to both; rerun migration | Existing owner access/data remain valid, new defaults/backfill are deterministic, rerun is a no-op, constraints/indexes/RLS exist | Planned | Pending implementation |
| FND02-M-002 | RLS coverage for all new tenant-bearing relations | Migration/security | Application DB role; Tenant A/B and no tenant contexts | Introspect policies and query/insert/update each new table/view under all contexts | FORCE RLS is present; only server-selected tenant rows are accessible/mutable; unset/forged context cannot broaden access | Planned | Pending implementation |
| FND02-I-001 | Invitation lifecycle and identity verification | Integration | Tenant A Owner and no existing target membership | Invite by email or mobile, preview, verify identity, satisfy optional/required MFA hook, accept | One identity/membership and normalized role/scope set are created; token is single-use/expiring/hashed; landing context is correct | Planned | Pending implementation |
| FND02-I-002 | Existing identity and invitation collision safety | Integration | Existing user in another/same tenant | Invite same normalized identity concurrently and accept/replay | Identity is linked without credential takeover; duplicate membership/token is prevented; replay is generic and mutation-free | Planned | Pending implementation |
| FND02-I-003 | Immediate authorization-version invalidation | Integration/security | Active session for user whose scope/role changes | Remove scope, change role, suspend user, or reset sessions; reuse old cookie immediately | Membership authorization version changes and all affected sessions/caches fail before any protected data/action; re-auth reflects new scope | Planned | Pending implementation |
| FND02-I-004 | MFA policy hooks and recovery state | Integration | Privileged and ordinary invitations under required/optional policy | Attempt login/accept before verification, complete challenge, disable MFA, reset enrollment | Required MFA blocks tenant entry until verified; optional path works; disable/reset is privileged, audited, alerts when required | Planned | Pending implementation |
| FND02-I-005 | Dynamic Driver assignment | Integration/security | Driver session and Trip 1 assigned, Trip 2 unassigned | Act on Trip 1, atomically reassign it, retry old/new driver actions | Current driver alone can perform allowed actions; old session loses access immediately without cached assignment leakage | Planned | Pending implementation |
| FND02-I-006 | Optimistic concurrency for access administration | Integration/contract | Two admins read same membership version | Both update roles/scopes or suspension state | One valid update wins; stale version receives conflict with no partial grants/sessions; audit records one change | Planned | Pending implementation |
| FND02-I-007 | Transactional account administration | Integration | Valid and invalid role/scope changes | Submit multi-role/scope update containing one invalid item | Entire update rolls back, authz version/session state remains unchanged, safe validation identifies field | Planned | Pending implementation |
| FND02-C-001 | User/invitation API schemas and non-production delivery seam | Contract | Owner session and CSRF | Exercise create/list/detail/revoke/resend/accept schemas and malformed requests | Versioned safe schemas, pagination and validation are stable; plaintext token appears only in authorized local fixture seam, never logs/audit | Planned | Pending implementation |
| FND02-C-002 | Administration API idempotency | Contract/integration | Valid create/resend/reset/suspend requests | Replay same key/body, then same key/different body | Same replay returns same result without duplicate events/audits; changed payload conflicts | Planned | Pending implementation |
| FND02-C-003 | Effective-permission preview/enforcement parity | Contract/security | Matrix of actors/resources/operations | Call preview then actual create/read/update/export/approve/administer route | Status and allow/deny result match for every matrix row; preview cannot reveal inaccessible identifiers/fields | Planned | Pending implementation |
| FND02-C-004 | Pagination/filter/sort/export scope | Contract/security | Mixed scoped resources and sensitive values | Request broad filters, extreme pages, sorts and CSV exports | Counts/rows/export remain within effective scope; stable ordering; CSV is formula-safe and masked; export denial cannot be bypassed | Planned | Pending implementation |
| FND02-C-005 | Authentication throttling and generic failure | Contract/security | Known/unknown/suspended identities | Submit repeated bad password/MFA/invitation challenges around exact threshold | Responses do not enumerate identity/state; counters are PostgreSQL-backed; alert threshold fires once per window and recovery works | Planned | Pending implementation |
| FND02-C-006 | Session cookie, CSRF, origin, and production-hook safety | Contract/security | Authenticated and anonymous callers | Forge/miss CSRF, origin, cookie; enable fixture hooks in production startup | Mutations fail safely; secure cookie attributes persist; production rejects fixture hooks and never exposes tokens/challenges | Planned | Pending implementation |
| FND02-A-001 | Regional Manager region scope through every operation | Authorization | North and South resources | List/detail/create/update/export/approve/administer and guess South ID | Only North operations with an explicit capability succeed; South and absent capabilities deny without existence leakage | Planned | Pending implementation |
| FND02-A-002 | KAM client scope through every operation | Authorization | Alpha and Beta resources across regions | Repeat operation matrix including broad query/export | Only Alpha resources/actions within explicit capabilities succeed; Beta is absent from counts, search and export | Planned | Pending implementation |
| FND02-A-003 | Vendor allocations/trips/payments boundary | Authorization | Red and Blue records with margins/payment data | Use portal and direct API IDs, broad filters, export attempts | Red-owned allowed records only; Blue and internal margin/unpermitted payment fields never leak; unrestricted export denied | Planned | Pending implementation |
| FND02-A-004 | Driver assigned actions boundary | Authorization | Assigned, unassigned, completed and reassigned trips | List/detail/action each trip through portal and direct API | Only current assigned actionable trips appear; completed/disallowed actions and old assignments deny safely | Planned | Pending implementation |
| FND02-A-005 | Client Viewer boundary | Authorization | Alpha/Beta records and internal/vendor/commercial data | View portal, direct detail, mutation, approval and export | Alpha permitted view is masked; unrelated/internal data and all unauthorized actions deny | Planned | Pending implementation |
| FND02-A-006 | Multi-role additive union and default deny | Authorization | Multi-role user with disjoint capability/scope grants | Exercise actions matching one role, both roles, neither, and a central policy block | Permitted union works without accidental scope cross-product; missing capability/scope denies; policy block wins | Planned | Pending implementation |
| FND02-A-007 | Cross-tenant and same-tenant ID guessing | Authorization/security | Known Tenant A/B and inaccessible Tenant A UUIDs | Request detail/update/export/approve with guessed IDs and supplied tenant hints | Foreign/inaccessible/unknown IDs have the same non-leaking status, code and response shape; client tenant hints are ignored | Planned | Pending implementation |
| FND02-A-008 | Denial security audit | Authorization/audit | Every denial class above | Trigger direct API and UI denial | Exactly one sanitized event records actor, tenant context, action, safe target type/hash, source and correlation ID without foreign metadata or secrets | Planned | Pending implementation |
| FND02-A-009 | Sensitive field defense across channels | Authorization/security | Masked and explicitly authorized users | Read list/detail/preview/export/report/alert/audit and inspect logs/errors | Values appear only where the precise field permission allows; masked paths cannot reconstruct length/value; no secondary-channel leakage | Planned | Pending implementation |
| FND02-A-010 | Suspended/deactivated access | Authorization/security | Suspended user/membership and tenant lifecycle variants | Login, reuse session, switch tenant, call protected API | Access is blocked immediately and generically while records remain; suspended-session attempt is audited and alerted | Planned | Pending implementation |
| FND02-R-001 | User directory and role-assignment reconciliation | Report/integration | Users with multiple roles/scopes/statuses in both tenants | Filter, paginate, drill and export directory/assignments | Visible totals equal canonical in-scope memberships/grants without role double counting; exports match visible scope/masking | Planned | Pending implementation |
| FND02-R-002 | Dormant, failed-login, and active-session reconciliation | Report/integration | Exact threshold activity, failed attempts, active/revoked/expired sessions | Run each report at fixed clock and drill details | Counts and states match canonical rows at boundaries; Tenant B and secret/token data never appear | Planned | Pending implementation |
| FND02-R-003 | Privileged-action and permission-change audit | Audit/reconciliation | Invite, role grant, scope removal, preview, suspend and reset actions | Query/filter/export audit report and attempt mutation | Each material change has one immutable before/after allow-listed event with reason/correlation; export is permission-scoped; update/delete rejected | Planned | Pending implementation |
| FND02-R-004 | Security alert thresholds/deduplication/recovery | Alert/reconciliation | Failed logins, MFA disabled, privileged grant, unexpected geography, suspended-session attempt | Trigger below/at/above thresholds, repeat, acknowledge/resolve condition | Alert appears only at configured condition, deduplicates with occurrence count, has safe action context, never escapes tenant/scope, and resolves correctly | Planned | Pending implementation |
| FND02-R-005 | Privileged access report masking | Report/security | Owner/Auditor/ordinary user | View and export reports with sensitive identity/action fields | Capability and tenant scope control rows/columns consistently; ordinary users cannot infer hidden actors or events | Planned | Pending implementation |
| FND02-X-001 | Accessible identity/access UI states | Component/Playwright | Invite, directory, editor, preview, portal and report screens | Run Axe and keyboard/focus/error-state checks | No serious/critical violations; labels, names, focus order, alerts, dialogs and tables are usable without pointer | Planned | Pending implementation |
| FND02-X-002 | Responsive and resilient UI | Component/Playwright | Desktop and narrow mobile viewports | Exercise loading, empty, validation, forbidden, server error and retry states | No horizontal loss of actions/data; states are announced; retry preserves safe input and never repeats a committed mutation | Planned | Pending implementation |
| E2E-FND02-01 | Invitation, validation, identity verification, and MFA | Playwright | Tenant A Owner and uninvited Regional Manager | Submit invalid form and prove no mutation; correct it with North scope; accept identity/MFA and land on queue | Accessible validation is atomic; one invitation/membership is created; verified user enters the correct home | Planned | Pending implementation |
| E2E-FND02-02 | Access lifecycle, immediate session invalidation, and recovery | Playwright | KAM active in two browser contexts | Owner previews/changes scope, resets/suspends access, retries old contexts, restores narrower access | Old sessions fail immediately; audit/alert evidence exists; reauthentication receives only restored scope | Planned | Pending implementation |
| E2E-FND02-03 | Internal scoped roles and preview/enforcement parity | Playwright | Regional Manager, KAM, and multi-role internal user | Compare preview with actual create/read/update/export/approve/admin operations across scoped resources | Region/client/multi-role decisions match production authorization without scope cross-product | Planned | Pending implementation |
| E2E-FND02-04 | Direct API denial, ID guessing, and security audit | Playwright | In-scope Tenant A actor, out-of-scope actor, Tenant B actor | Call known same-tenant and cross-tenant IDs plus broad list/export paths | Responses are non-leaking and equivalent; exactly one sanitized correlated denial audit exists per attempt | Planned | Pending implementation |
| E2E-FND02-05 | External portals and sensitive-field masking | Playwright | Vendor Owner, Driver and Client Viewer | Exercise own/unrelated records, Driver reassignment, actions, detail and exports | Portal scopes remain constrained; policy blocks and masking hold across UI/API/CSV; no internal margin leak | Planned | Pending implementation |
| E2E-FND02-06 | Report/alert reconciliation, accessibility, and mobile | Playwright/Axe | Seeded users/sessions/security events; required screens and portal shells | Reconcile reports/alerts, then exercise representative flows by keyboard at desktop/mobile widths and run Axe | Counts/drills/exports match canonical rows; responsive recovery works; zero serious/critical Axe violations | Planned | Pending implementation |

## Unit tests

- `FND02-U-001` through `FND02-U-006` use table-driven inputs against the same exported pure policy/masking functions called by middleware and preview. They prove that `ADMIN` implies the other actions only within the same capability family and matched assignment/scope, while `READ`, `UPDATE`, `APPROVE`, and `EXPORT` do not imply one another. Mutation testing should demonstrate that dropping tenant, capability, scope, status, MFA, policy-block, or assignment predicates fails at least one case.
- `FND02-U-002` covers tenant root, each typed scope, ancestor/descendant matching supported by the neutral hierarchy, conjunctive constraints, expired grants, and the absence of a matching grant.
- `FND02-U-004` recomputes assigned-trip access after assignment changes; it does not treat a role or cached trip list as authorization.
- `FND02-U-005` asserts exact safe outputs, including null/short values, Unicode, values sharing prefix/suffix, CSV serialization, and permission combinations. Internal margin is never exposed to external portal policies even through a multi-role union unless the user is acting through an eligible internal membership and explicit policy permits it.
- `FND02-U-007` validates normalized identities without assuming email delivery, SMS delivery, TOTP provider, SSO provider, or later employee master records.

## Integration and migration tests

- `FND02-M-001` runs migration from both a clean database and the committed FND-01 schema containing active owners, invitations, sessions, probes, events, reports, and audits. It verifies forward-safe backfill, constraints, indexes, defaults and Prisma migration history.
- `FND02-M-002` obtains tenant-bearing relations from PostgreSQL catalog metadata and requires an explicit tested isolation classification for each. It fails when a newly added tenant table/view lacks FORCE RLS or a reviewed exception.
- `FND02-I-001` verifies invitation creation, resend/revoke/expiry, acceptance, identity linking, MFA hook state, assigned roles/scopes and one role-appropriate session as one consistent lifecycle.
- `FND02-I-003` verifies `membership.authz_version` (or approved equivalent) is compared at request time and that all affected sessions are revoked or made stale in the same transaction as role/scope/suspension/reset changes.
- `FND02-I-005` uses a current assignment relation and concurrent reassignment transaction. Authorization follows committed assignment and never a stale client-supplied driver/trip identifier.
- `FND02-I-006` and `FND02-I-007` require expected-version checks and full rollback. Database uniqueness/exclusion constraints are asserted alongside service validation.

## API/contract, idempotency, and concurrency tests

- Every mutating administration route validates CSRF/origin, schema, tenant context, capability, scope, expected version, and `Idempotency-Key` where retry is legitimate.
- `FND02-C-002` asserts one canonical response, domain mutation, outbox event, audit event, authz-version change, and alert side effect for duplicate retries. A reused key with a different normalized payload returns conflict.
- `FND02-C-003` is a generated matrix whose preview row is immediately exercised against the matching operation endpoint. Create preview uses a validated proposed resource descriptor; read/update/export/approve/administer use accessible or deliberately inaccessible existing fixtures. Safe reason codes may explain the caller's own missing capability/scope but may not identify foreign resources.
- `FND02-C-004` checks permitted totals, page metadata, broad search, sorting, saved filter input if exposed, and formula-leading CSV cells. UI route removal is never accepted as evidence of authorization.
- Concurrency tests run without timing sleeps: transactions/barriers coordinate simultaneous invitation acceptance, role/scope updates, reassignment, suspension, and session use.

## Authorization and tenant-isolation tests

- `FND02-A-001` through `FND02-A-006` parameterize all representative operations over in-scope and out-of-scope neutral resources. The test fails if a controller, service, repository, report, or export bypasses the centralized evaluator.
- Cross-product protection is explicit: a client capability from one role cannot combine with an unrelated vendor grant from another to authorize a resource that matches neither complete grant.
- `FND02-A-007` compares inaccessible-known, foreign-known, malformed-valid-shape, and unknown UUID results for status, error code, public body keys and absence from result counts. Timing is treated as a diagnostic signal, not a brittle exact-duration assertion.
- `FND02-A-008` associates every denial with its response correlation ID and verifies the audit target uses an opaque/safe identifier where the real target is outside scope.
- `FND02-A-009` searches serialized JSON, CSV bytes, HTML, report projections, audit snapshots, alert payloads, and captured application logs for raw fixture secrets and sensitive values.
- `FND02-A-010` covers user suspension, tenant-membership suspension, tenant deactivation inherited from FND-01, session reset, expired session, and attempted tenant switch.

## Reconciliation and audit tests

- Directory and assignment totals reconcile to distinct active/invited/suspended memberships as defined by the report filter; multiple roles do not multiply users.
- Active-session totals exclude revoked and expired sessions at the fixed clock. Dormancy and failed-login windows have before/at/after boundary cases.
- Permission-change and privileged-action reports reconcile one-to-one with immutable, allow-listed audit events and preserve request/correlation ID drill-down.
- Alert reconciliation compares canonical failed-attempt/MFA/role/geography/session-attempt rows to open/resolved alert occurrence counts. Reprocessing the same source event is idempotent.
- All report list, count, drill-down and export queries are executed as Tenant A and Tenant B actors and as a denied ordinary user.

## Playwright journeys

### E2E-FND02-01 — Invitation, validation, identity verification, and MFA

The Tenant Owner first submits an invalid Regional Manager invitation containing malformed identity/scope data and verifies accessible field errors plus no membership, grant, event, or audit mutation. The owner corrects it with North read/create/update/export access, reviews effective permissions, and sends it. The invited user verifies identity, completes deterministic local TOTP enrolment/challenge, lands on the Regional Manager queue, and observes one reconciled directory/assignment/audit result.

### E2E-FND02-02 — Access lifecycle, immediate invalidation, and recovery

A KAM stays active in two browser contexts while the owner previews and removes scope, resets sessions, and tests suspension. The next protected request in both contexts is rejected immediately. The owner observes permission-change audit and suspended-attempt alert evidence, restores a narrower allowed scope, and the user reauthenticates without regaining removed access.

### E2E-FND02-03 — Internal scoped roles and preview parity

Regional Manager, KAM, and a multi-role internal user preview and attempt representative create/read/update/export/approve/administer operations against North/South and Alpha/Beta fixtures. Actual decisions match preview. Capability and scope must succeed within the same assignment, so combining unrelated roles cannot create an accidental scope cross-product.

### E2E-FND02-04 — Direct API denial and security audit

An in-scope Tenant A actor, an out-of-scope Tenant A actor, and a Tenant B actor call known same-tenant and foreign UUIDs, unknown UUIDs, broad search, report, and export paths. Inaccessible and unknown resources have the same safe response contract. Correlation IDs locate exactly one sanitized denial audit per attempt without foreign labels, tenants, or sensitive values.

### E2E-FND02-05 — External portals and masking

Vendor Owner, Driver, and Client Viewer use their role-appropriate portal shells. The Vendor sees only its neutral allocation/trip/payment fixtures, the Driver only current assigned-trip actions including after reassignment, and the Client only its client-facing status. Direct API and export attempts prove unrelated parties, unrestricted exports, commercial/payment restrictions, and internal margins remain blocked or masked.

### E2E-FND02-06 — Reports, alerts, accessibility, and mobile

Failed-login, privileged-grant, MFA-disabled, trusted-geography and suspended-attempt fixtures reconcile report rows, drill-down, CSV and alert occurrence/state to canonical events. Then run invite, directory/editor, effective-preview, role home, portal shells, reports and alerts at desktop and narrow mobile viewports. Use keyboard-only interaction for representative paths and recovery, validate focus/announcements/dialogs/tables, and run Axe with zero serious or critical violations.

## Accessibility and responsive checks

- Every input has a persistent accessible name, hint/error association, required state, and deterministic focus target after validation.
- Scope hierarchy selection exposes checked/expanded/mixed states without relying on color; effective allow/deny and masked values include text/icon semantics.
- Role and scope summaries are readable tables/lists, not inaccessible token clouds. Bulk selection and preview remain keyboard operable.
- Confirmation dialogs for suspension/session reset/revocation return focus and require the documented reason where applicable.
- Loading, empty, forbidden, stale-version, expired-invitation, MFA-required and backend-error states are announced and offer safe recovery.
- Desktop and mobile assertions cover invite, access editor/preview, directory, role home, Vendor/Driver/Client shells, reports, alerts and session controls.

## Failure injection and recovery

- Persisted fixture controls inject an invitation-delivery failure, MFA challenge rejection/expiry, audit/outbox failure, concurrent version conflict, stale session authorization version, and report/alert projection lag. Test controls remain authenticated, CSRF-protected, non-production-only, allow-listed, and reject production startup.
- Invitation delivery retry reuses the intended invitation and does not generate a second active token/membership unless a deliberate revoke-and-reissue transition occurs.
- An audit/outbox persistence failure rolls back the privileged role/scope/suspension mutation rather than leaving unaudited access.
- A stale-version conflict reloads current assignments before retry and never silently overwrites another admin's change.
- Report/alert projection recovery is idempotent and reconciles to canonical rows without duplicates or cross-tenant processing.
- Browser retry controls are safe: they preserve non-secret user input when appropriate, clear password/MFA secrets, and do not repeat already committed requests.

## Commands

```bash
make check
make deploy-local
make health
make e2e
make verify
```

## Approval

- [x] Every acceptance criterion has at least one test ID
- [x] Boundary and negative cases are explicit
- [x] Required fixtures are deterministic and tenant-isolated
- [x] Primary agent approved

## Final execution synchronization

- [ ] Every test ID has a final status and evidence
- [ ] No unexplained skipped/only/quarantined test remains
- [ ] Test file names and IDs match this plan
- [ ] `FEATURES.md`, `README.md`, `TODO.md`, and `completion.md` show the same result
