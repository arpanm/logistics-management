# FND-01 — Test Plan

**Plan status:** Executed
**Overall test status:** Passing
**Related spec:** `specs/FND-01/spec.md`

## Scope and test oracle

This plan verifies the first deployable multi-tenant slice: protected tenant provisioning, transactional defaults and owner invitation, tenant-derived request/session context, tenant switching, deactivation/reactivation, the setup checklist, minimum tenant-owned proof records, documents, PostgreSQL-backed events/jobs/alerts, reporting projections, platform health, and isolation across every exposed channel. FND-02 owns the complete identity/capability model; FND-01 tests only the minimum Platform Admin, Tenant Owner, and multi-tenant-member permissions needed to prove this foundation.

The authoritative oracle is persisted PostgreSQL state plus the documented HTTP/WebSocket contracts. UI messages alone are not sufficient evidence. Any endpoint or resource added by implementation must be included in the parameterized resource/channel inventories before this plan can be approved.

## Risks

1. A caller-controlled tenant identifier could override the tenant established by the authenticated session.
2. An unscoped repository, reporting view, export, document lookup, event subscription, or background-job claim could disclose or mutate another tenant's data.
3. Provisioning could partially commit defaults or create duplicate invitations when retried.
4. Tenant switching could retain cached branding, counts, recent records, or subscriptions from the prior tenant.
5. Deactivation could leave existing sessions, jobs, or event delivery active, or reactivation could fail to restore records without loss.
6. Platform metrics could expose business details or disagree with canonical tenant/user/event/job records.
7. Migration/schema ownership could affect another project using the central PostgreSQL container.
8. Locale, timezone, currency, fiscal-year, GSTIN/tax identifier, and tenant-code validation could accept ambiguous or unsafe configuration.
9. Provisioning failure alerts or repeated-job-failure alerts could be dropped, duplicated, or leak tenant payloads.
10. Frontend loading/error/retry behavior, narrow-screen layout, focus handling, or keyboard access could make the setup journey unusable.

## Fixtures and environments

### Environment

- Local services: frontend `http://127.0.0.1:3000`, backend `http://127.0.0.1:4000`, and the existing central `shared-postgres` container only.
- Application database: `logistics`; isolated test database: `logistics_test`; schemas: `app`, `audit`, and `reporting`.
- Tests must prove that setup/migration touches only the configured project databases, role, and schemas. They must not stop, reset, or delete the shared container/volume.
- Freeze application time at `2026-08-24T10:30:00.000Z` in service-level tests. Browser tests use persisted absolute expiry values and observable expiry state rather than changing the workstation clock.
- Clean deterministic data by feature-owned test reset/seed commands that reject non-test database URLs. Each Playwright worker uses a unique run suffix; tests do not depend on execution order.

### Deterministic identities and tenant records

| Fixture | Identity / key facts | Purpose |
|---|---|---|
| Platform Admin | `platform.admin@example.test`; platform-admin session | Provision, deactivate/reactivate, and view platform health |
| Tenant A Owner | `owner.a@example.test`; owner of Tenant A only | Positive Tenant A and negative Tenant B access |
| Tenant B Owner | `owner.b@example.test`; owner of Tenant B only | Symmetric isolation proof |
| Multi-tenant Member | `switcher@example.test`; active member of A and B | Tenant switch and state-clear proof |
| Unassigned User | `unassigned@example.test`; no tenant membership | Non-leaking denial proof |
| Tenant A | code `ACME-A`; branding `Indigo Freight`; `Asia/Kolkata`; `en-IN`; `INR`; fiscal start `04-01` | Tenant-specific presentation and calendar configuration |
| Tenant B | code `BETA-B`; branding `Amber Haulage`; `America/New_York`; `en-US`; `USD`; fiscal start `01-01` | Deliberately different tenant context |
| Tenant C | code `FAIL-C`; injected failure after defaults but before invitation/outbox commit | Atomic rollback and recovery |

Tenant A and Tenant B each receive distinct legal entity, configuration, default roles, reason lists, thresholds, setup checklist states, proof record/recent record, document bytes/checksum, audit event, alert, PostgreSQL-backed domain event, background-job row, reporting projection, and exportable row. IDs are UUIDs generated from fixed fixture namespaces so direct-ID guessing cases are reproducible.

### Inventories that tests must maintain

- `tenant-owned-table inventory`: derived from database metadata plus an explicit allowlist of non-tenant/platform tables. Every non-platform application, audit, and reporting table must have a non-null tenant key, tenant-safe keys/foreign keys, and a negative-access case.
- `resource/channel inventory`: tenant profile, branding/settings, legal entity, setup checklist, proof/recent record, document metadata/bytes, audit/event/alert, background job, reporting projection, search/list/detail/write endpoint, bulk export, and WebSocket subscription/delivery.
- `provisioned-default inventory`: roles, reason lists, thresholds, legal entity, checklist, and exactly one pending expiring owner invitation/event.

Adding a tenant-owned table, endpoint, export, projection, document type, job/event handler, or subscription without adding it to the relevant inventory fails the meta-tests.

## Acceptance-to-test matrix

| Test ID | Acceptance/risk | Layer | Preconditions | Action | Expected result | Status | Evidence |
|---|---|---|---|---|---|---|---|
| FND01-U-001 | Tenant input validation and normalization | Unit | Valid/invalid field table | Validate tenant name/code/legal/tax/address/timezone/locale/currency/fiscal start/contact/active inputs | Valid values normalize deterministically; malformed, unsupported, overlong, or unsafe values return field errors | Passing | `make check`: domain/config unit suites, 19/19 |
| FND01-U-002 | Owner invitation expiry and singularity policy | Unit | Frozen time; retry keys | Build invitation on first request, retry, and after expiry | One unexpired invitation is produced per provisioning operation; expiry is future/UTC; retry does not duplicate | Passing | `make check`: domain and provisioning integration assertions |
| FND01-U-003 | Tenant context and switch policy | Unit | Single-, multi-, inactive-, and unassigned memberships | Resolve/switch context with caller-supplied conflicting tenant values | Context is derived from active membership; unauthorized/inactive targets are denied; client tenant input cannot override it | Passing | `make check` plus `E2E-FND01-03/05` |
| FND01-U-004 | Deactivation and job eligibility | Unit | Active and deactivated tenants with queued jobs | Evaluate login/session/use/job-claim policy | Deactivated tenant is ineligible without deleting data; active/reactivated tenant is eligible | Passing | Backend integration suite plus `E2E-FND01-04` |
| FND01-U-005 | Platform metrics and alert rules | Unit | Canonical tenant/user/storage/event/job facts at alert boundaries | Aggregate metrics and evaluate failure thresholds | Counts/freshness reconcile; alerts contain operational metadata only and deduplicate as specified | Passing | Backend reconciliation suite plus `E2E-FND01-05` |
| FND01-M-001 | Clean and forward-safe migration | Migration | Empty `logistics_test` project schemas | Apply all migrations, inspect, then re-run deploy/migrate | Required schemas/tables/views/indexes exist; re-run is no-op; no unrelated database/schema/container is altered | Passing | Clean two-migration deploy, no-op re-run, unrelated sentinel preserved |
| FND01-M-002 | Tenant-key constraints and catalog coverage | Integration | Migrated database | Inspect every table/view in the tenant-owned inventory and attempt null/cross-tenant relationships | Tenant keys are non-null where owned; keys/FKs prevent cross-tenant relationships; every resource is classified | Passing | Exact 13-table RLS/force/policy/index inventory and bidirectional tests |
| FND01-I-001 | Atomic tenant provisioning and exactly one invitation | Integration | Platform Admin; no `ACME-A` tenant | Provision Tenant A and inspect all schemas/outbox | Tenant, complete defaults, legal entity, checklist, audit/outbox, and exactly one future-expiring owner invitation commit together | Passing | Backend provisioning integration plus `E2E-FND01-01` |
| FND01-I-002 | Idempotent provisioning retry/concurrency | Integration | Stable idempotency key; concurrent requests | Submit identical provisioning twice sequentially and concurrently | One tenant and one invitation/default set exist; responses resolve to the same operation; conflicting payload is rejected | Passing | Sequential/concurrent same-key and conflicting-payload integration cases |
| FND01-I-003 | Provisioning rollback and alert recovery | Integration | Tenant C; injected transactional failure | Fail after partial work, inspect state/alert, remove failure, retry | No partial tenant/default/invite persists; one sanitized platform alert is recorded; retry succeeds once | Passing | Backend rollback/reconciliation plus `E2E-FND01-04` |
| FND01-I-004 | Deactivate/reactivate persistence and session/job enforcement | Integration | Active tenants, sessions, queued jobs, proof records | Deactivate, attempt session/login/job claim, then reactivate | Access and claims stop immediately; records remain; reactivation restores authorized access without recreation/loss | Passing | Lifecycle/job/session integration plus `E2E-FND01-04` |
| FND01-I-005 | Setup checklist state and audit | Integration | Tenant A Owner; valid expected version | Complete/reopen checklist steps; submit stale concurrent version | Allowed state persists with actor/UTC/version audit; stale update returns conflict and does not overwrite | Passing | Checklist version/audit integration plus `E2E-FND01-01` |
| FND01-C-001 | Tenant provisioning API contract | API/contract | Authenticated Platform Admin | POST valid, invalid, duplicate-code, unknown-field, and unsupported locale/timezone/currency payloads | Documented success/error schemas and status codes; validation creates no partial mutation | Passing | Backend contract cases plus `E2E-FND01-02` desktop/mobile |
| FND01-C-002 | Owner invitation issue/acceptance contract | API/contract | Pending, expired, already-used invitations | Retrieve/accept each invitation state | Pending invite can be accepted once; token is not stored/logged in plaintext; expired/used tokens fail without leakage | Passing | One-time/concurrent/existing-identity cases plus `E2E-FND01-01/05` |
| FND01-C-003 | Platform-only lifecycle/health authorization | API/security | Platform Admin, Tenant Owner, anonymous sessions | List/create/deactivate/reactivate tenants and read platform report | Only Platform Admin succeeds; denials are non-leaking and audited; report contains no cross-tenant business rows | Passing | Anonymous/role/denial-audit integration plus Playwright isolation |
| FND01-A-001 | Server-derived tenant context on all HTTP operations | Authorization | Tenant A/B owners and conflicting header/body/query/cookie values | Exercise resource inventory list/search/detail/create/update/export/document/report endpoints | Only active-session tenant is used; foreign IDs look absent/non-leaking; no cross-tenant mutation or bytes leave server | Passing | Backend context tests plus `E2E-FND01-03` six-channel denial |
| FND01-A-002 | Every tenant-owned table/resource is isolated | Integration/security | Complete two-tenant inventory | Run parameterized repository read/search/write/delete/foreign-ID cases for both directions | Every owned resource rejects A→B and B→A; catalog/resource coverage meta-check has zero omissions | Passing | Exact 13-table catalog and A↔B/platform visibility tests |
| FND01-A-003 | PostgreSQL-backed jobs/events/alerts are isolated | Integration/security | Per-tenant jobs, events, alerts and workers/dispatchers | Claim/deliver/retry using each tenant context, including inactive tenant | Only matching active tenant work is selected/delivered; payloads never cross; inactive work remains unclaimed | Passing | Job/event/alert RLS, dispatcher, inactive-tenant integration cases |
| FND01-A-004 | WebSocket transport is closed in the FND-01 boundary | Contract/security | Running backend; authenticated and anonymous callers | Attempt WebSocket upgrades with forged tenant/record IDs before and after tenant switch | No WebSocket route accepts the upgrade and no event payload is delivered; PostgreSQL event access remains available only through scoped service boundaries | Passing | `E2E-FND01-03` confirms upgrade path returns 404 without payload |
| FND01-A-005 | Documents, reporting, and bulk export isolation | Integration/contract | Distinct A/B document, projection, export rows | Guess foreign IDs and apply broad search/filter/export inputs | Foreign document metadata/bytes, report rows, totals, and exported cells are absent; platform health remains aggregate-only | Passing | Backend bidirectional resource tests plus `E2E-FND01-03` |
| FND01-R-001 | Platform report reconciliation and privacy | Reconciliation | Known active/inactive tenants, memberships, sizes, failures, activity | Query canonical sources and platform report | Active tenant/user counts, storage, health/failure counts, freshness/last activity reconcile; no tenant business payload is exposed | Passing | Exact backend reconciliation plus `E2E-FND01-05` |
| FND01-R-002 | Audit completeness and immutability | Reconciliation/security | Provision, invite accept, switch, checklist, deactivate/reactivate, denial/failure actions | Compare state transitions with audit records; attempt edit/delete | One correlated immutable audit trail exists per action with actor/source/UTC/before-after/reason; secrets and document bytes are absent | Passing | Audit correlation/denial/RLS/immutable trigger integration cases |
| FND01-R-003 | Provisioning and repeated-job alerts reconcile | Reconciliation | Inject one provisioning failure and job failures below/at/above threshold | Run alert evaluator repeatedly | Alerts match canonical failures and configured threshold, deduplicate retries, and reveal no cross-tenant business data | Passing | Failure evaluator/dedup integration plus `E2E-FND01-04` |
| E2E-FND01-01 | Primary provisioning, invite, and setup success | Playwright | Fresh Platform Admin; no Tenant A | Create Tenant A through UI, accept owner invitation, complete the available branding checklist step | Defaults/invite/checklist are visible and persisted; exactly one pending/consumed invitation lifecycle is observed | Passing | `make e2e`: desktop and mobile |
| E2E-FND01-02 | Validation with no partial mutation | Playwright | Platform Admin; known baseline counts | Submit missing/invalid/duplicate tenant fields | Focus moves to useful labelled errors; no tenant/default/invite/audit-success record is added; correction succeeds | Passing | `make e2e`: desktop/mobile, field association and Axe checks |
| E2E-FND01-03 | Unauthorized and cross-tenant channel isolation | Playwright + API/WebSocket | A/B users and records | From Tenant A UI/session, navigate/guess/request B resources, export/document/report, and subscribe to B alerts | UI exposes no B data; direct channels return non-leaking denial/absence; B payload is never rendered/downloaded/delivered | Passing | `make e2e`: desktop/mobile, suspension and six-channel denial |
| E2E-FND01-04 | Provisioning exception plus deactivate/reactivate recovery | Playwright | Failure-injection hook scoped to test; active Tenant A | Trigger Tenant C failure/retry; deactivate A; attempt access/job; reactivate A | Failure is actionable and retry-safe; deactivated access is blocked with records retained; reactivation restores them | Passing | `make e2e`: desktop/mobile, typed lifecycle confirmation |
| E2E-FND01-05 | Tenant switch and platform-report reconciliation | Playwright + API | Multi-tenant member; distinct A/B data; Platform Admin | Switch A→B→A and compare report drill values to fixture API/database facts | Switcher only appears for multi-tenant user; branding/settings/counts/recent rows and subscriptions fully change; platform totals reconcile | Passing | `make e2e`: desktop/mobile, identity-link and fresh-login selection |
| FND01-X-001 | Accessibility and keyboard behavior | Component/Playwright | Primary screens in success/error/empty/loading states | Run automated smoke scan and keyboard-only create/switch/checklist flows | No serious/critical violations; labels, names, focus order, error association/status announcements, dialogs, and skip/focus behavior work | Passing | Axe on five surfaces per viewport; zero serious/critical violations |
| FND01-X-002 | Responsive and state recovery | Playwright | Desktop and narrow/mobile projects; delayed/failed API route | Exercise create, report, switcher, checklist, error and retry at both viewports | No clipped controls/horizontal page overflow; tables remain usable; loading/empty/error/retry are perceivable and recover without duplicate writes | Passing | `make e2e`: desktop/mobile plus 320px/topbar regression |

## Unit tests

- `FND01-U-001`: table-driven schema/domain tests for required fields, whitespace/case normalization, code format, GSTIN/tax identifier as tenant data (without Juri Gari-specific constants), IANA timezone, BCP 47 locale, ISO currency, `MM-DD` fiscal start, address/support contact, active flag, length limits, and rejected extra fields.
- `FND01-U-002`: invitation expiry uses UTC and a configurable lifetime; token material is cryptographically generated and only a hash persists; same provisioning operation cannot issue a second owner invite.
- `FND01-U-003`: membership selection covers zero, one, multiple, suspended/deactivated, stale active-tenant, and conflicting caller-supplied tenant IDs. Switching rotates or updates server-side context and emits a cache/subscription invalidation signal.
- `FND01-U-004`: policy tests distinguish platform administration from tenant access while ensuring deactivation prevents new login, invalidates/denies existing tenant context, and removes work from job eligibility.
- `FND01-U-005`: report aggregation uses canonical facts; storage units and nullable last-activity values are deterministic; configurable repeated-failure thresholds test below, exact, and above boundaries; retry deduplication is stable.

## Integration and migration tests

- `FND01-M-001` runs migrations on clean project schemas and on an already-migrated database, verifies migration history/readiness, database privileges, and confirms that an unrelated sentinel database/schema in the central container is unchanged.
- `FND01-M-002` derives actual tenant-owned tables/views from PostgreSQL metadata. It fails on an unclassified table, nullable tenant key, globally unique tenant-owned natural key, or foreign key capable of relating different tenants.
- `FND01-I-001` asserts one database transaction covers the tenant, legal entity, configurable roles/reasons/thresholds, checklist, invitation, audit event, and outbound invitation event. Email transport is not required; the persisted invitation event is the delivery contract for this baseline.
- `FND01-I-002` covers stable idempotency keys, unique tenant code, simultaneous requests, and same-key/different-payload conflict.
- `FND01-I-003` uses a test-only injectable failure boundary, proves transaction rollback, records a sanitized platform-operational failure outside the rolled-back transaction, and succeeds after the fault is removed.
- `FND01-I-004` verifies rows/counts/checksums before and after lifecycle changes; sessions and job claims are rejected based on current tenant state, not stale cached state.
- `FND01-I-005` verifies optimistic version conflict and immutable audit correlation for checklist changes.

## API/contract and idempotency tests

- `FND01-C-001` validates content type, body schema, response schema, idempotency header/field behavior, status codes, error correlation ID, pagination/sorting on tenant list, and absence of secrets.
- `FND01-C-002` checks token secrecy, expiry, one-time acceptance, deterministic already-used behavior, and membership creation. Raw invitation tokens may appear only in the one-time test delivery adapter response/event, never in logs, audits, or database plaintext.
- `FND01-C-003` checks anonymous and tenant-role denial for every platform-only operation. Error bodies must not reveal whether a guessed foreign tenant/resource exists.
- API retry cases assert persisted row counts and side effects, not merely equal response bodies.

## Authorization and tenant-isolation tests

- `FND01-A-001` parameterizes all HTTP operations over the resource/channel inventory and tries foreign UUID, tenant code, query filter, body tenant ID, header, cookie, and export selection tampering.
- `FND01-A-002` parameterizes every tenant-owned table/repository in both A→B and B→A directions. Direct database fixtures are used only for setup/assertion; behavior under test enters through production repository/service boundaries. The catalog-to-test-inventory comparison must be exact.
- `FND01-A-003` proves tenant predicates and active-state checks are applied during job/event claim, lease, retry, and delivery. It includes a broad/unscoped worker request and confirms it cannot deliver tenant payload without explicit reviewed platform orchestration.
- `FND01-A-004` asserts the backend exposes no WebSocket upgrade route in FND-01 for anonymous or authenticated callers, including forged tenant selection. Event isolation is verified at the PostgreSQL-backed service/dispatcher boundary; a future transport must add its own authenticated subscription tests.
- `FND01-A-005` asserts both metadata and bytes for documents; rows and totals for reporting; and headers, rows, formulas/content, and filenames for export. Broad filters cannot broaden scope.
- Denied access creates a sanitized security audit event in the correct scope without confirming the foreign resource's existence.

## Reconciliation and audit tests

- `FND01-R-001`: calculate active tenants, distinct active memberships/users, database/schema storage, integration/job-event failure state, and last activity from seeded canonical records; compare field-by-field with the platform report. Any size tolerance must be documented because PostgreSQL relation size can vary, while counts must be exact.
- `FND01-R-002`: correlate each material action by request/correlation ID. Audit events are append-only under the application role; token hashes/secrets, document bytes, and unrelated tenant business details never appear in platform views.
- `FND01-R-003`: reconcile platform alerts to the provisioning failure and persisted job-attempt records. Re-evaluation or process restart must not duplicate an alert for the same failure window/idempotency key.

## Playwright journeys

### E2E-FND01-01 — Primary success

1. Sign in as Platform Admin and open the protected tenant console.
2. Create Tenant A using every documented field and a stable idempotency key behind the form submission.
3. Verify the success detail/checklist, configured branding, default inventory counts, legal entity, and exactly one owner invitation with a future expiry through supported API fixture assertions.
4. Open the test delivery invitation link, accept once as Tenant A Owner, and confirm the tenant home/checklist.
5. Complete the available branding checklist item and reload to prove persistence and audit correlation; future-module checklist items remain unavailable.

### E2E-FND01-02 — Validation with no partial mutation

1. Record tenant/default/invitation counts using the supported fixture API.
2. Submit required-field omissions, invalid timezone/locale/currency/fiscal-start/contact, unsafe/overlong text, and a duplicate code.
3. Assert labelled inline errors, focus/summary behavior, no success announcement, and unchanged persisted counts.
4. Correct the values and submit once; assert exactly one resulting tenant/invitation.

### E2E-FND01-03 — Unauthorized tenant/role/scope

1. Confirm the Tenant A Owner has no platform console and a single-tenant user has no switcher.
2. Use Tenant A's authenticated browser context to guess Tenant B UI URLs and call Tenant B list/search/detail/write/report/export/document endpoints.
3. Attempt a WebSocket upgrade with a forged Tenant B record/tenant ID and verify the deliberately absent FND-01 transport remains closed.
4. Assert non-leaking denial/not-found behavior, no B mutation/download/rendered text/event payload, and a sanitized security audit event.

### E2E-FND01-04 — Material exception and recovery

1. Enable the supported test-only provisioning failure for Tenant C and submit the valid form.
2. Assert an actionable error/retry UI, no partial Tenant C state, and one platform failure alert; disable the fault and retry to one successful result.
3. Deactivate Tenant A as Platform Admin. Prove new and existing Tenant A access and job handling stop while canonical row counts/checksums remain.
4. Reactivate Tenant A and prove owner access/checklist/proof records return without recreation or data loss.

### E2E-FND01-05 — Downstream/report reconciliation

1. Sign in as the multi-tenant member on Tenant A; verify Indigo branding, INR/locale/timezone settings, A counts/recent record, and A-only event delivery.
2. Switch to Tenant B and assert the URL/session context plus Amber branding, USD/locale/timezone settings, B counts/recent record. Assert no stale A text/network response/subscription event remains.
3. Switch back to A to prove repeatability. Verify the switcher is absent for Tenant A Owner.
4. As Platform Admin, open the health report and compare active/user/failure/activity values with canonical fixture API facts; verify no tenant business-record text is displayed.

## Accessibility and responsive checks

- `FND01-X-001` covers sign-in, tenant list/empty state, create form errors/success, tenant detail/checklist, switcher, deactivation confirmation, invitation acceptance, and platform report. Use an established accessibility scanner if installed plus explicit keyboard/focus/accessible-name assertions.
- Destructive lifecycle controls have clear names, confirmation, focus containment/return, and status announcements. Required/invalid fields expose programmatic relationships and do not rely on color alone.
- `FND01-X-002` runs the primary and validation surfaces on configured desktop and mobile/narrow projects. Data tables may use responsive overflow inside their region but the page itself must not horizontally overflow; primary actions remain reachable and targets remain operable.
- Delayed and failed route interception validates loading, empty, error, retry, duplicate-click prevention, and preserved safe form input without arbitrary sleeps.

## Failure injection and recovery

- Test-only failure controls must require test environment plus privileged fixture authentication and must be impossible to enable in a production build/configuration.
- Provisioning injection occurs inside the transaction after some defaults are staged but before invitation/outbox commit (`FND01-I-003`, `E2E-FND01-04`).
- Job/event tests inject failed attempts below, exactly at, and above the configured repeated-failure threshold, then run evaluator twice to prove recovery and deduplication (`FND01-U-005`, `FND01-R-003`).
- UI route failure/delay is browser-local and proves retry does not issue duplicate writes (`FND01-X-002`).
- Database unavailability is reflected by readiness while liveness remains process-level; the test must not stop the shared central container. Use a deliberately invalid test-only database connection for a separately started backend or a dependency adapter fault.

## Commands

```bash
make policy-check
make postgres-status
make check
make deploy-local
make health
make e2e
make verify
```

Focused commands introduced by FND-01 must support running unit, migration/integration, contract/security, reconciliation, and Playwright files independently. The final evidence records exact commands, result counts, and locally deployed URLs; generated reports/traces/screenshots stay uncommitted.

## Approval

- [x] Every acceptance criterion has at least one test ID
- [x] Boundary and negative cases are explicit
- [x] Required fixtures are deterministic and tenant-isolated
- [x] Primary agent approved

## Final execution synchronization

- [x] Every test ID has a final status and evidence
- [x] No unexplained skipped/only/quarantined test remains
- [x] Test file names and IDs match this plan
- [x] `FEATURES.md`, `README.md`, `TODO.md`, and `completion.md` show the same result
