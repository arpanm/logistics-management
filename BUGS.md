# Bug and failed-acceptance register

This register began with the 12 failures from `specs/ALL-FEATURES-E2E-STATUS.md`. RCA is based on real Playwright execution against the locally deployed frontend, backend, and shared PostgreSQL database. The original 12 issues are resolved; current open regressions are listed below.

## Summary

| Bug         | Failed test                 | Feature       | Classification         | Severity      | Root cause                                                                                                                                                | Status                          |
| ----------- | --------------------------- | ------------- | ---------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| BUG-E2E-001 | E2E-FOUND-FND01-05          | FND-01        | Product correctness    | P1 / Medium   | Platform report reads totals and rows from different PostgreSQL snapshots                                                                                 | Resolved                        |
| BUG-E2E-002 | OPS02-UI-001                | OPS-02        | Test automation        | P2 / Medium   | Brittle exact label locator cannot resolve a visible wrapped select                                                                                       | Resolved                        |
| BUG-E2E-003 | OPS03-UI-001                | OPS-03        | Test automation        | P2 / Medium   | Brittle exact label locator cannot resolve a visible wrapped select                                                                                       | Resolved                        |
| BUG-E2E-004 | DOC01-UI-001                | DOC-01        | Test automation        | P2 / Medium   | Brittle exact label locator cannot resolve a visible wrapped select                                                                                       | Resolved                        |
| BUG-E2E-005 | FIN02-UI-001                | FIN-02        | Test automation        | P2 / Medium   | Brittle exact label locator cannot resolve a visible wrapped select                                                                                       | Resolved                        |
| BUG-E2E-006 | FIN01-UI-001                | FIN-01        | Test automation        | P2 / Low      | Success assertion ambiguously matches two live status regions                                                                                             | Resolved                        |
| BUG-E2E-007 | FIN03-UI-001                | FIN-03        | Test automation        | P2 / Low      | Success assertion ambiguously matches two live status regions                                                                                             | Resolved                        |
| BUG-E2E-008 | E2E-ALT01-01                | ALT-01        | Product integration    | P1 / High     | Generic alert records and operational alert queues use disconnected stores                                                                                | Resolved                        |
| BUG-E2E-009 | E2E-ALT01-04                | ALT-01        | Product integration    | P1 / High     | Alert action API cannot find records created through the advertised generic API                                                                           | Resolved                        |
| BUG-E2E-010 | E2E-ALT01-05                | ALT-01        | Product integration    | P1 / High     | Alert reconciliation reads a store that never received the created alert                                                                                  | Resolved                        |
| BUG-E2E-011 | E2E-INT01-01                | INT-01        | Product UI             | P1 / High     | Async form handler loses its form reference and skips state refresh                                                                                       | Resolved                        |
| BUG-E2E-012 | E2E-INT01-04                | INT-01        | Product integration    | P1 / High     | Generic delivery records and operational delivery/dead-letter stores are disconnected                                                                     | Resolved                        |
| BUG-GAP-001 | FND01-M-001                 | FND-01        | Test maintenance       | P2 / Low      | Exact migration inventory omitted the new canonical all-feature migration                                                                                 | Resolved                        |
| BUG-GAP-002 | FND01-A-006                 | FND-01        | Test maintenance       | P2 / Low      | Exact tenant-table RLS inventory omitted the new canonical tenant relations                                                                               | Resolved                        |
| BUG-GAP-003 | FND02-I/C/A suite           | FND-02        | Product regression     | P1 / High     | Tenant Owner can no longer delegate baseline scoped roles after migration 007                                                                             | Resolved                        |
| BUG-GAP-004 | FND02-C-005/R-004           | FND-02        | Product regression     | P1 / High     | Repeated-login security alerts are not created/reported after canonical alert changes                                                                     | Resolved                        |
| BUG-GAP-005 | E2E-GAP-XF-01..07           | ALL           | Test infrastructure    | P1 / High     | Consolidated Playwright fixtures stall at Platform registry and reporter loses step IDs                                                                   | Resolved                        |
| BUG-GAP-006 | Canonical commands          | ALL           | Security               | P0 / Critical | Same-tenant IDs bypass assignment/resource scope checks in commands and governance                                                                        | Resolved                        |
| BUG-GAP-007 | Create/import paths         | DAT/Masters   | Security               | P0 / Critical | Create/import validates capability but not supplied parent/resource scope                                                                                 | Resolved                        |
| BUG-GAP-008 | Sensitive fields            | FND-02        | Security               | P1 / High     | Generic ADMIN action reveals data without explicit sensitive-read capabilities                                                                            | Resolved                        |
| BUG-GAP-009 | Finance ledgers             | FIN-01/02/03  | Correctness            | P1 / High     | Bigint money crosses unsafe JavaScript Number conversions                                                                                                 | Resolved                        |
| BUG-GAP-010 | Local workers               | GOV/INT       | Product correctness    | P1 / High     | Local adapters falsely mark unscanned files and unsent messages successful                                                                                | Resolved                        |
| BUG-GAP-011 | Migration 007               | FND-02        | Upgrade regression     | P1 / High     | Existing baseline roles are not backfilled with new domain capabilities                                                                                   | Resolved                        |
| BUG-GAP-012 | Alert queue/actions         | ALT-01        | Security               | P1 / High     | Rule-less alerts are readable/actionable tenant-wide without resource scope                                                                               | Resolved                        |
| BUG-GAP-013 | E2E-GAP-OPS02-01            | OPS-02        | Test fixture           | P2 / Low      | Eligibility scenario reused an already eligible vendor                                                                                                    | Resolved                        |
| BUG-GAP-014 | E2E-GAP-OPS03-03            | OPS-03        | Test assertion         | P2 / Low      | Regression expected an obsolete report response shape                                                                                                     | Resolved                        |
| BUG-GAP-015 | E2E-GAP-OPS03-02            | OPS-03        | Test fixture           | P2 / Low      | Offline ordering scenario reused an immutable event key                                                                                                   | Resolved                        |
| BUG-GAP-016 | FND01-04/05                 | FND-01        | Test navigation        | P2 / Low      | Lifecycle and tenant-selection checks assumed an obsolete landing route                                                                                   | Resolved                        |
| BUG-GAP-017 | E2E-FOUND-FND01-05          | FND-01        | Product UI             | P1 / Medium   | Platform report rendered the integration-health object directly as a React child                                                                          | Resolved                        |
| BUG-GAP-018 | E2E-GOV01-01                | GOV-01        | Product routing        | P1 / High     | Policy URL renders the governed-evidence workspace, so policy create/edit fields are absent                                                               | Resolved                        |
| BUG-GAP-019 | Five UI cases × 2 viewports | FND-01/FND-02 | Test maintenance       | P2 / Medium   | Regression tests targeted superseded submit, invitation, permission-preview, and report controls                                                          | Resolved                        |
| BUG-GAP-020 | FND02-AUTH-REC-\*           | FND-02        | Product authentication | P1 / High     | Activated users had no discoverable repeat-login guidance or password-recovery path                                                                       | Resolved                        |
| BUG-OPS-021 | OPS-WB-11                   | OPS-02        | Product API            | P1 / High     | Auto-allocation register SQL closed an authorization group that had never been opened                                                                     | Resolved                        |
| BUG-MST-022 | MST02-CONTRACT-SEARCH-I-001 | MST-02        | Product API            | P1 / High     | Contract-version search selected lifecycle state from a version table that has no state column                                                            | Resolved                        |
| BUG-CTL-023 | UIREG-CTL-API-001..005      | CTL-01        | Product API            | P0 / Critical | Aggregate summary subqueries correlated an ungrouped outer location column, failing every lens                                                            | Resolved; focused smoke Passing |
| BUG-UI-024  | UIREG-OPS/FIN/DETAIL        | UI-01         | Responsive UX          | P1 / High     | Global table minima, desktop dialog geometry and in-flow details broke compact layouts/discovery                                                          | Resolved locally / Not Run      |
| BUG-UI-025  | UI02-OPS/FIN/CTL/DETAIL     | UI-02         | Responsive UX/contract | P1 / High     | Desktop flex forms, offset sticky actions, raw details, global mid-word wrapping and unchecked Control response fields reproduced compact-layout failures | Resolved locally / Not Run      |
| BUG-CTL-026 | CTL-DB-026 / UI02-CTL-010   | CTL-01/UI-02  | Product API contract   | P1 / High     | A PostgreSQL derived-table alias collided with its `vendor` column, serializing vendor names instead of structured allocation totals                      | Resolved; focused tests Passing |
| BUG-CTL-027 | CTL drill scope             | CTL-01/UI-02  | Product UI state       | P1 / High     | Drill depth changed before the scoped response arrived, briefly rendering prior all-portfolio locations under the selected client/vendor breadcrumb       | Resolved locally; E2E Not Run   |

## Detailed RCA

### BUG-CTL-026 — Placement vendor allocation summaries failed closed

- **Observed:** The production Placement lens returned HTTP 200 but the UI reported `vendor allocation totals were incomplete`.
- **RCA:** The vendor metadata query used `vendor` for both the derived-table alias and the scalar name column. PostgreSQL resolved `to_jsonb(vendor)` to the scalar, producing `vendors: ["Sahil Roadlines", ...]` instead of structured records.
- **Resolution:** The backend now constructs every vendor object explicitly with `id`, `vendor`, `allotted`, `placed`, and `ntp`, while retaining tenant/resource authorization and canonical state predicates. No migration or seed repair is required.
- **Evidence:** Focused backend contract tests passed 6/6, PostgreSQL reconciliation passed 4/4, and real-browser `UI02-CTL-010` passed 1/1 after local production build/restart.
- **Status:** Resolved locally and ready for the production deployment recorded with this fix.

### BUG-CTL-027 — Client/vendor drill briefly showed unrelated locations

- **Observed:** In POD, Collection, Trips, and Vendor Payable, selecting a portfolio initially displayed multiple locations/accounts and then collapsed to the selected scope.
- **RCA:** React changed the breadcrumb/drill depth immediately while `data` still held the preceding unfiltered response. The debounced `clientId` request later replaced it with the correct server projection; the final single row was generally correct and the initial rows were stale.
- **Resolution:** Settled dashboards are now keyed by the exact lens and normalized query. A scope change renders an accessible loading/error state until its matching response settles; aborted, stale-key, and out-of-order responses are ignored. Same-scope background refresh retains the settled board.
- **Evidence:** Focused request-key tests passed 3/3 and frontend typecheck/build/readiness passed. The first browser revision was blocked in unrelated setup by an expired allocation; the corrected read-only four-lens case is Implemented / Not Run and no passing browser result is claimed.
- **Status:** Resolved; production release evidence is the deployed Git SHA reported with this change.

### BUG-CTL-023 — All five Control Tower lens APIs returned HTTP 500

- **Observed:** Placement, POD, Collection, Trip and Vendor Payable reads failed with `INTERNAL_ERROR` after bounded pagination was introduced.
- **RCA:** PostgreSQL `42803` reported `subquery uses ungrouped column f.location from outer query`; summary subqueries reused the outer aggregate alias. Placement also joined assignment history before summing allocations, risking quantity fan-out.
- **Resolution:** Metadata now uses independent `base`, `filtered` and one-row `summary` CTEs, with breakdowns evaluated outside the aggregate. Allocation quantities aggregate once per indent and asset history aggregates separately. Real-PostgreSQL and five independent no-mock browser cases are Implemented / Not Run.
- **Runtime evidence:** After the production build/restart, authenticated real-database smoke reads returned HTTP 200 with Placement 14, POD 14, Collection 18, Trip 18 and Vendor Payable 14 rows. Backend/frontend readiness both reported database connected and 28 migrations current.
- **Status:** Resolved locally; focused five-lens smoke Passing. The authored Playwright/integration suites remain Implemented / Not Run.

### BUG-UI-024 — Compact workbenches overflowed and details appeared at the page end

- **Observed:** Operations and Finance created document-level horizontal scroll and desktop-sized dialogs on mobile; Users, POD and similar View details actions silently appended content after long pages.
- **RCA:** An unscoped global table minimum combined with shrink-unbounded grids and desktop-only register/dialog layouts. Detail components used in-flow sections rather than a focus-managed overlay.
- **Resolution:** Tables are width-bounded, compact registers use semantic record cards, and one shared portal modal supplies mobile-sheet geometry, internal scrolling, sticky actions, background locking, focus trap/restoration and local mutation errors. User, POD, canonical, module, transaction, Platform tenant, Organization and Employee details use the overlay contract.
- **Status:** Resolved locally; responsive Playwright and contract cases are Implemented / Not Run.

### BUG-MST-022 — Contract-version search returned HTTP 500

- **Observed:** `GET /api/v1/domain/commands/contracts/versions?search=...` returned `INTERNAL_ERROR`, blocking the searchable Contract version reference and therefore lane creation.
- **RCA:** The query projected `v.state` from `app.contract_versions`; lifecycle state is stored on the joined parent `app.contracts` row.
- **Resolution:** The projection now uses `c.state` while preserving tenant filtering and per-contract resource authorization. Focused integration passed `3/3`; the no-mock Chromium lane journey passed `1/1`, proving the searched version is selectable and lane creation returns `201`. Mobile and full regression were not run in this focused fix.
- **Status:** Resolved locally.

### BUG-OPS-021 — Auto-allocation rule register returned HTTP 500

- **Observed:** `GET /api/v1/operations/auto-allocation-rules` returned `INTERNAL_ERROR`; PostgreSQL reported `42601 syntax error at or near ")"`.
- **RCA:** The sensitive commercial-rate `CASE` expression closed an overall authorization group without opening it.
- **Resolution:** The expression is now correctly grouped while retaining tenant, client, lane, vendor, and sensitive-rate authorization. `OPS-WB-11` is Implemented / Not Run; PostgreSQL successfully planned the complete corrected query with `EXPLAIN`.
- **Status:** Resolved locally.

### BUG-GAP-018 — Governance policy route does not expose policy administration

- **Observed:** A real-browser focused run of `E2E-GOV01-01` opens `/app/governance/policies`, but the page heading is `Governed evidence`; the expected policy `Code` and structured `Rule values` controls do not exist.
- **RCA:** The route is wired to `GovernanceWorkspace` (record evidence) instead of the policy administration workspace promised by the route and feature flow.
- **Impact:** Tenant administrators cannot create or edit governance policies from the advertised URL.
- **Evidence:** Focused Playwright timeout at `getByLabel("Code")`; screenshot retained in `test-results/all-features-intelligence--11858-nce-and-governance-features-chromium/test-failed-2.png`.
- **Resolution:** `/app/governance/policies` now renders structured policy list/create/edit/enable/disable controls backed by tenant-root authorized, idempotent APIs with role validation, optimistic concurrency, audit, and outbox evidence.
- **Status:** Resolved in the rapid remediation batch; regression `GOV-WB-01` is Implemented / Not Run pending an explicitly requested test phase.

### BUG-GAP-019 — Legacy browser cases target superseded FND user interfaces

- **Observed:** `make verify` completed with 166 passed, 10 failed, and 12 not run. The five unique failures repeat in desktop/mobile: `E2E-FND01-02`, `E2E-FND02-01`, `E2E-FND02-02`, `E2E-FND02-06`, and `E2E-FOUND-FND02-05`.
- **RCA:** The tests predate intentional UX changes: invalid tenant submission is disabled until required inputs are present; invitation links use the activation lifecycle panel; authorization diagnostics use Permission tester; reports are split into searchable Activity & audit tables rather than a `Report` dropdown.
- **Impact:** The repository-wide gate was red even though focused PIN acceptance passed 2/2 and the newer FND-02 structured administration journeys passed.
- **Resolution:** Tests now assert the disabled invalid submit, activation lifecycle panel, Permission tester, and searchable Activity & audit tables. The duplicate-tenant helper clears a retained PIN before refilling so the real postal request is deterministic.
- **Status:** Resolved; focused compatibility is 10/10 and final `make verify` is 188/188 passing.

### BUG-GAP-020 — Activated users cannot recover a forgotten password

- **Observed:** A Client/Vendor/Driver/internal user could activate an invitation and enter the product, but after logout the login screen neither explained that the activation password must be reused nor offered password recovery.
- **RCA:** Invitation acceptance created the platform password correctly, but the FND-02 lifecycle ended at activation. No reset-token persistence, public request/complete API, recovery UI, or tenant-admin provider-free recovery action had been implemented.
- **Impact:** A user who forgot or did not retain the activation password required direct database/seed intervention and could not safely regain access.
- **Resolution:** Activation now explains password ownership; login records a generic provider-delivery recovery request without claiming provider-free delivery; tenant-root administrators can rotate and copy a reset URL once for an active single-tenant identity. Shared cross-tenant identities require a configured verified-delivery provider. Completion rotates the Argon2 credential and revokes all sessions and outstanding reset tokens.
- **Status:** Resolved in implementation; `FND02-AUTH-REC-U01` and `FND02-AUTH-REC-001..003` are Implemented / Not Run.

### BUG-E2E-001 — Platform report is internally inconsistent during concurrent tenant writes

- **Failed test:** `E2E-FOUND-FND01-05`
- **Feature:** FND-01
- **Classification:** Product correctness defect
- **Severity:** P1 / Medium
- **Observed:** During the parallel suite, `/api/v1/platform/report` returned `totals.total=276` and 277 tenant rows. The same case passed without a concurrent writer.
- **Expected:** `totals.total` must equal `tenants.length`; active and inactive totals must equal the statuses in that same response.
- **Reproduction:** Run the foundation/master Playwright spec in parallel while other workers provision tenants, then request the platform report during a provision commit.
- **Root cause:** `platformReport()` executes the aggregate query and tenant-row query as separate statements. `withPlatform()` uses PostgreSQL's default `READ COMMITTED` isolation, so each statement gets a new snapshot. A provision can commit between the two statements.
- **Code evidence:** `apps/backend/src/app.service.ts:1291-1310`, `packages/db/src/index.ts:9-18`, `playwright.config.ts:5-10`, and `tests/e2e/all-features-foundation-masters.spec.ts:166`.
- **Impact:** Platform health/report responses can be transiently self-contradictory during provisioning or lifecycle changes. No persistent corruption or tenant leak was observed.
- **Workaround:** Avoid concurrent tenant writes while reading the report, or retry until totals reconcile. This is not a durable correction.
- **Recommended fix:** Produce rows and aggregates in one SQL statement over one CTE/snapshot. A report-specific `REPEATABLE READ` transaction is an acceptable alternative.
- **Regression tests:** Deterministically interleave report generation with provision, deactivate, and reactivate commits; assert count/status reconciliation, zero rows, and the existing parallel desktop/mobile journey without assertion retries.

### BUG-E2E-002 — OPS-02 Offer channel selector produces a false-negative timeout

- **Failed test:** `OPS02-UI-001`
- **Classification:** Test automation defect; no product defect demonstrated
- **Severity:** P2 / Medium
- **Observed:** The test timed out before submit while operating `Offer channel`. The failure snapshot exposed the visible combobox and expected options; no POST occurred.
- **Expected:** Select `PORTAL`, submit once, receive HTTP 201, and verify exact persisted allocation data.
- **Root cause:** The test uses `getByLabel(field.label, { exact: true })` for dynamic fields. Production uses an implicit wrapping label containing the select and option descendants. Exact label matching is brittle for this structure. The current DOM-evaluate attempt still begins from the unresolved locator.
- **Code evidence:** `tests/e2e/all-features-operations-finance.spec.ts:409-418`, `apps/frontend/app/app/operations/_components/transaction-workspace.tsx:142-165`, and `apps/frontend/app/app/operations/allocations/page.tsx:27-32`.
- **Impact:** False-negative acceptance result and long timeout; no allocation mutation occurred.
- **Recommended fix:** Use `getByRole("combobox", { name: "Offer channel", exact: true }).selectOption("PORTAL")` and assert the selected value.
- **Regression tests:** Run desktop/mobile; assert one POST 201, exact success text, queue row, and API detail values.

### BUG-E2E-003 — OPS-03 Milestone event selector produces a false-negative timeout

- **Failed test:** `OPS03-UI-001`
- **Classification:** Test automation defect; no product defect demonstrated
- **Severity:** P2 / Medium
- **Observed:** The test timed out at `Milestone event`, although the snapshot showed the combobox and all milestone options. No POST occurred.
- **Expected:** Select `GATE_IN`, create one trip, and verify the exact milestone payload.
- **Root cause:** Same shared exact-label locator defect as BUG-E2E-002.
- **Code evidence:** `tests/e2e/all-features-operations-finance.spec.ts:409-418`, `apps/frontend/app/app/operations/_components/transaction-workspace.tsx:142-165`, and `apps/frontend/app/app/operations/trips/page.tsx:16-31`.
- **Impact:** False-negative trip result; no trip mutation occurred.
- **Recommended fix:** Use the named combobox role and `selectOption("GATE_IN")`.
- **Regression tests:** Desktop/mobile, one POST 201, exact status message, queue row, and persisted milestone/time/quantity values.

### BUG-E2E-004 — DOC-01 POD mode selector produces a false-negative timeout

- **Failed test:** `DOC01-UI-001`
- **Classification:** Test automation defect; no product defect demonstrated
- **Severity:** P2 / Medium
- **Observed:** The test timed out at `POD mode`, while the visible combobox contained all expected options. No POST occurred.
- **Expected:** Select the POD mode, create the record, and verify all persisted delivery-document fields.
- **Root cause:** Same shared exact-label locator defect as BUG-E2E-002.
- **Code evidence:** `tests/e2e/all-features-operations-finance.spec.ts:409-418`, `apps/frontend/app/app/operations/_components/transaction-workspace.tsx:142-165`, and `apps/frontend/app/app/pod/page.tsx:31-37`.
- **Impact:** False-negative POD result; no POD mutation occurred.
- **Recommended fix:** Select the named combobox through its accessible role and assert its value.
- **Regression tests:** Desktop/mobile HTTP 201, exact success text, queue/detail presence, and POD field persistence.

### BUG-E2E-005 — FIN-02 payment Mode selector produces a false-negative timeout

- **Failed test:** `FIN02-UI-001`
- **Classification:** Test automation defect; no product defect demonstrated
- **Severity:** P2 / Medium
- **Observed:** The test timed out at `Mode`, although the visible combobox contained all configured payment modes. No POST occurred.
- **Expected:** Select the mode, create one receipt, and verify exact amount, instrument, bank, and allocation fields.
- **Root cause:** Same shared exact-label locator defect as BUG-E2E-002.
- **Code evidence:** `tests/e2e/all-features-operations-finance.spec.ts:409-418`, `apps/frontend/app/app/operations/_components/transaction-workspace.tsx:142-165`, and `apps/frontend/app/app/finance/receipts/page.tsx:25-31`.
- **Impact:** False-negative receipt result; no receipt mutation occurred.
- **Recommended fix:** Use the named combobox role and `selectOption(...)`.
- **Regression tests:** Desktop/mobile single POST, HTTP 201, exact success message, queue/detail presence, and exact minor-unit persistence.

### BUG-E2E-006 — FIN-01 successful invoice creation fails an ambiguous status assertion

- **Failed test:** `FIN01-UI-001`
- **Classification:** Test automation defect; production mutation succeeded
- **Severity:** P2 / Low
- **Observed:** Invoice creation returned HTTP 201 and persisted, but `getByRole("status")` matched both creation success and `Loading queue…`.
- **Expected:** Target only the exact invoice-created success message, then verify list/detail persistence.
- **Root cause:** Create sets a success status and concurrently reloads the queue. Both are valid `role="status"` nodes, so an unqualified role locator violates strictness.
- **Code evidence:** `apps/frontend/app/app/operations/_components/transaction-workspace.tsx:82-84,114-117,183-190` and the corrected but not fully rerun locator at `tests/e2e/all-features-operations-finance.spec.ts:429-431`.
- **Impact:** False-negative after a real invoice was created; test data remains persisted.
- **Workaround:** Verify the invoice via its queue card or detail API.
- **Recommended fix:** Target exact success text or `.success` instead of all status regions.
- **Regression tests:** Desktop/mobile, exactly one POST 201, exact success message, visible invoice card, and matching detail values.

### BUG-E2E-007 — FIN-03 successful vendor-bill creation fails an ambiguous status assertion

- **Failed test:** `FIN03-UI-001`
- **Classification:** Test automation defect; production mutation succeeded
- **Severity:** P2 / Low
- **Observed:** Vendor-bill creation returned HTTP 201 and persisted, then the shared status assertion matched success and queue loading.
- **Expected:** Assert only the vendor-bill-created message and continue to queue/detail verification.
- **Root cause:** Same concurrent status-region ambiguity as BUG-E2E-006.
- **Code evidence:** `apps/frontend/app/app/operations/_components/transaction-workspace.tsx:82-84,114-117,183-190` and `tests/e2e/all-features-operations-finance.spec.ts:429-431`.
- **Impact:** False-negative after a real payable record was created.
- **Recommended fix:** Use an exact success-message locator or `.success` status.
- **Regression tests:** Desktop/mobile, one POST 201, exact success, visible bill card, and exact payable/tax/deduction values.

### BUG-E2E-008 — Created alert never appears in the operational queue

- **Failed test:** `E2E-ALT01-01`
- **Classification:** Product integration defect
- **Severity:** P1 / High
- **Observed:** POST `/api/v1/modules/alerts/alert` returned 201 and a UUID, but `/app/alerts` and GET `/api/v1/tenant/alerts` omitted it.
- **Expected:** A supported alert create/occurrence path must produce the same canonical record consumed by queue and actions.
- **Root cause:** The manifest exposes `alert` as a generic kernel resource, so creation writes `app.module_records`. The operational queue reads only `app.operational_alerts`. `upsertOccurrence()` is the only canonical writer and has no supported caller/controller.
- **Code evidence:** `apps/backend/src/modules/alerts/manifest.ts:27-32`, `apps/backend/src/modules/kernel/manifests.ts:21-32`, `apps/backend/src/modules/kernel/kernel.service.ts:143-171`, and `apps/backend/src/modules/alerts/alerts.provider.ts:32-45,108-131`.
- **Impact:** The advertised API creates orphaned alerts that cannot be actioned, reported, or reconciled.
- **Workaround:** No supported positive UI/API workflow exists.
- **Recommended fix:** Use one canonical store. Prefer removing generic alert CRUD and adding an occurrence-ingestion boundary that calls `upsertOccurrence`, or atomically adapt generic creation into `app.operational_alerts`.
- **Regression tests:** Create a canonical occurrence; assert the same UUID in UI/queue; verify ACK/RESOLVE, tenant isolation, and report totals.

### BUG-E2E-009 — Alert stale-version recovery returns 404 before version validation

- **Failed test:** `E2E-ALT01-04`
- **Classification:** Product integration defect
- **Severity:** P1 / High
- **Observed:** Resolving the generic alert UUID returned `404 RESOURCE_NOT_FOUND`, not stale `409` followed by a successful current-version retry.
- **Expected:** Locate the canonical alert, reject stale version atomically, and accept the current version.
- **Root cause:** Shared store split from BUG-E2E-008. `AlertsProvider.action()` searches only `app.operational_alerts`, but the UUID belongs to `app.module_records`; it fails before version comparison.
- **Code evidence:** `apps/backend/src/modules/alerts/alerts.provider.ts:48-91` and the generic kernel paths in BUG-E2E-008.
- **Impact:** Supported alert IDs cannot participate in acknowledgement, assignment, snooze, escalation, or resolution.
- **Recommended fix:** Route creation and actions through one canonical identity/version store.
- **Regression tests:** Stale action returns 409 without mutation; current action increments once; idempotent replay returns the same result.

### BUG-E2E-010 — Resolved alert queue cannot reconcile created alerts

- **Failed test:** `E2E-ALT01-05`
- **Classification:** Product integration defect
- **Severity:** P1 / High
- **Observed:** The resolved operational queue remained empty and could not include or count the alert created through the generic route.
- **Expected:** Resolved queue total must equal returned rows and include the resolved alert UUID.
- **Root cause:** Shared store split from BUG-E2E-008. Queue/report reads `app.operational_alerts`; generic creation writes `app.module_records`.
- **Code evidence:** `apps/backend/src/modules/alerts/alerts.provider.ts:32-45` and the generic kernel paths in BUG-E2E-008.
- **Impact:** Alert analytics and queues cannot reconcile with exposed metadata-driven alert records.
- **Recommended fix:** Use the same canonical record for ingestion, actions, queue, and reporting.
- **Regression tests:** Resolve a canonical alert and reconcile filtered queue count, rows, action history, and report totals.

### BUG-E2E-011 — Integration persists but health UI does not refresh

- **Failed test:** `E2E-INT01-01`
- **Classification:** Product UI defect
- **Severity:** P1 / High UX
- **Observed:** UI submission persisted the endpoint and API returned it, but the health tab did not display it without reload.
- **Expected:** After POST 201, reset the form, reload endpoint state, and render the new health card.
- **Root cause:** `create()` reads `event.currentTarget`, awaits POST, then dereferences `event.currentTarget.reset()`. After the async boundary the event's `currentTarget` can be null. The thrown error enters catch and skips `await load()`, leaving stale local state.
- **Code evidence:** `apps/frontend/app/app/integrations/page.tsx:35-79,127-156`.
- **Impact:** Users may create duplicates because the UI appears stale or failed even though persistence succeeded.
- **Workaround:** Reload the page or use Retry after submission.
- **Recommended fix:** Capture `const form = event.currentTarget` before awaiting, build `FormData` from it, then call `form.reset(); await load()`. Show success separately from API errors.
- **Regression tests:** Submit via UI, wait for one POST 201, assert no alert/page error, see the card without reload, then reload and confirm persistence.

### BUG-E2E-012 — Generic delivery cannot enter dead-letter replay lifecycle

- **Failed test:** `E2E-INT01-04`
- **Classification:** Product integration defect
- **Severity:** P1 / High
- **Observed:** POST `/api/v1/modules/integrations/delivery` returned 201, but replaying that UUID through `/api/v1/tenant/integrations/dead-letters/:id/replay` returned 404.
- **Expected:** A supported delivery path should create a canonical delivery, dead-letter a failure, and replay the canonical dead-letter ID.
- **Root cause:** The manifest exposes `delivery` as a generic kernel resource in `app.module_records`. Operational APIs use `app.integration_deliveries` and `app.integration_dead_letters`. `recordDelivery()` has no supported caller/controller, and no supported path fails/dead-letters a canonical delivery.
- **Code evidence:** `apps/backend/src/modules/integrations/manifest.ts:26-38`, `apps/backend/src/modules/kernel/manifests.ts:21-32`, `apps/backend/src/modules/kernel/kernel.service.ts:143-171`, and `apps/backend/src/modules/integrations/integrations.provider.ts:66-176`.
- **Impact:** Delivery logs, failure handling, replay, and health cannot complete a positive lifecycle through supported APIs.
- **Workaround:** None through supported APIs or UI.
- **Recommended fix:** Remove generic delivery CRUD or route it to the canonical provider. Add a supported enqueue and PostgreSQL-backed failure transition that atomically creates a dead letter.
- **Regression tests:** Enqueue idempotently; fail to `DEAD_LETTER`; verify UI/API identity; reject short reason without mutation; replay to `PENDING`; increment replay count; reconcile health totals; deny cross-tenant UUID access.

## Root-cause consolidation

The 12 failed cases represent six underlying causes:

1. PostgreSQL snapshot inconsistency: BUG-E2E-001.
2. Shared Playwright select-locator defect: BUG-E2E-002 through BUG-E2E-005.
3. Shared Playwright status-locator defect: BUG-E2E-006 and BUG-E2E-007.
4. Alert persistence-boundary defect: BUG-E2E-008 through BUG-E2E-010.
5. Integration frontend refresh defect: BUG-E2E-011.
6. Integration delivery persistence-boundary defect: BUG-E2E-012.

## Consolidated all-feature gap run — 2026-08-25

### BUG-GAP-003 — FND-02 delegation regression blocks eight integration cases

- **Observed:** `make check` completed formatting, lint, typecheck, unit tests, clean migration 007, and FND-01 tests, then the FND-02 suite finished with 4 passed and 10 failed. The first failure was `DELEGATION_DENIED` while the Tenant Owner invited the baseline Regional Manager. KAM and external-portal invitation paths failed identically.
- **Cascaded evidence:** Later scope, denial, access-edit, concurrency, and portal cases used actors/membership IDs that the failed invitation was meant to create. Those failures surfaced as undefined actors or PostgreSQL `22P02` UUID casts and are classified as blocked cascades, not eight independent product defects.
- **Expected:** A provisioned Tenant Owner must retain delegability for every baseline role/capability/scope combination allowed before migration 007.
- **Likely boundary:** Migration 007 adds domain capabilities and role grants, changing the capability/delegation catalogue used by `AccessService.validateDelegation` without updating the FND-02 baseline delegation model consistently.
- **Affected named tests:** FND02-I-001/I-002/C-001/C-002; A-001/A-002/A-006/C-003/C-004; A-007/A-008/A-009; I-003/I-006/I-007/A-010; A-002/A-006; A-003/A-004/A-005/I-005.
- **Status:** Resolved. Tenant Owner delegation now proves the requested capability and TENANT-root ADMIN grant within one active assignment; FND-02 passes 14/14.

### BUG-GAP-004 — Repeated-login alert reconciliation regressed

- **Observed:** After the fifth invalid login, `app.security_alerts` contained zero `REPEATED_LOGIN_FAILURES` rows. The report/alert reconciliation case consequently could not find that alert.
- **Expected:** Below-threshold attempts create no alert; the threshold attempt creates one deduplicated alert with occurrence count one; alert/report totals reconcile.
- **Likely boundary:** The canonical alert integration added for the all-feature batch does not preserve the existing FND-02 security-alert creation/reporting path.
- **Affected named tests:** FND02-I-004/C-005/C-006 and FND02-R-001..R-005.
- **Status:** Resolved. Post-upsert rolling counts drive the threshold and the canonical security alert reconciles in the passing FND-02 suite.

### BUG-GAP-005 — Consolidated browser matrix cannot complete reliably

- **Observed:** The real-service Playwright file discovered 16 desktop/mobile journey executions and started five Chromium workers. The initial XF-01..XF-05 journeys remained at the Platform Tenant registry, emitted repeated `Internal error: step id not found: fixture@...`, generated failure screenshots, and did not finish after exceeding the configured 240-second test timeout. The run was terminated after more than five minutes with no trustworthy per-ID final ledger.
- **Expected:** All eight journeys finish in both projects and attach one machine-readable result for each of the 50 stable gap IDs.
- **Impact:** The original run could not classify feature behavior.
- **Status:** Resolved. Playwright workers are bounded, fixtures are deterministic, and all 50 IDs pass in desktop and mobile Chromium.

### BUG-GAP-006 through BUG-GAP-012 — Independent review blockers

- **BUG-GAP-006:** Advanced organization, commercial, operations, finance, document, comment, approval, and report paths commonly check only that the actor has a capability on some grant, then accept arbitrary same-tenant target IDs. Region/client/vendor-scoped actors can access or mutate resources outside their grants.
- **BUG-GAP-007:** Generic create and import paths do not prove that supplied parents, scope nodes, clients, or vendors fall inside the actor's grant. Imports can also create null-scope records, preventing consistent downstream authorization.
- **BUG-GAP-008:** Canonical serializers use a generic `ADMIN` action to reveal PAN, GSTIN, mobile, bank, rate, payment, and margin values instead of requiring the corresponding `sensitive.*.read` capability.
- **BUG-GAP-009:** Financial commands accept ordinary integer numbers and convert PostgreSQL bigint values through JavaScript `Number`; values above `Number.MAX_SAFE_INTEGER` can be rounded in append-only ledger operations.
- **BUG-GAP-010:** PostgreSQL-only workers mark email/SMS/notification attempts `DELIVERED` without a provider and mark every non-EICAR upload `CLEAN/VERIFIED` without a malware scanner. Local adapters must stay pending/simulated and must not confer real security or delivery state.
- **BUG-GAP-011:** Migration 007 grants new domain capabilities only to Tenant Owner. Existing upgraded Regional, Traffic, Finance, Driver, Vendor, Client, and Auditor roles are not backfilled to match newly provisioned tenants.
- **BUG-GAP-012:** Rule-less alerts are exposed to any internal actor with `alerts.read`, and action lookups use tenant plus alert UUID without resource-scope evaluation.
- **Evidence:** Independent read-only review of the final production diff after the consolidated test run.
- **Status:** Resolved. Target-resource authorization, scoped imports, explicit sensitive capabilities, BigInt-only finance, truthful local-adapter states, role backfills, and alert-source authorization have focused regression coverage and pass the consolidated suite.

## Resolution evidence

- **BUG-E2E-001:** Platform totals and tenant rows now come from one materialized PostgreSQL snapshot. The concurrent reconciliation case passes in desktop and mobile Chromium.
- **BUG-E2E-002 through BUG-E2E-005:** Tests use the named combobox role with `selectOption` and verify the chosen value. Each record receives one HTTP 201 and persists exact detail values on desktop and mobile.
- **BUG-E2E-006 and BUG-E2E-007:** Tests target the exact creation-success message while preserving queue/detail checks. Both pass on desktop and mobile.
- **BUG-E2E-008 through BUG-E2E-010:** Alert creation, queue, actions, and reports use the canonical operational alert store with mandatory tenant-scoped idempotency and optimistic versions. Creation, stale recovery, resolution, and reconciliation pass on desktop and mobile.
- **BUG-E2E-011:** The integration form captures its DOM reference before awaiting, reloads canonical state, and displays the new endpoint without navigation. The case passes on desktop and mobile.
- **BUG-E2E-012:** Delivery creation, dead-lettering, replay, detail, and reporting use the canonical integration tables. The regression proves two fail/replay cycles on one delivery, ending at version 5 with replay count 2, in desktop and mobile Chromium.

The backend regression suite also covers required idempotency keys, reordered-body replay, changed-body conflicts, tenant namespacing, stale versions, immutable delivery fields, concurrent failure/replay lock behavior, CSRF, low-capability and cross-tenant denials, payload secrecy, and exact-once audit records.

## Consolidated gap-batch failures

### BUG-GAP-001 — Migration inventory was stale after canonical migration

- **Failed test:** `FND01-M-001`
- **Observed:** The clean migration run applied `202608250007_all_feature_canonical`, but the legacy exact-list assertion expected only the preceding five migrations.
- **RCA:** A forward migration was correctly introduced, while the catalog meta-test remained hard-coded to the old inventory.
- **Impact:** False-negative test result; migration application itself succeeded and the second deploy reported no pending migrations.
- **Status:** Resolved. The exact eight-migration inventory passes on clean and upgraded databases.

### BUG-GAP-002 — RLS catalog inventory was stale after canonical tables

- **Failed test:** `FND01-A-006`
- **Observed:** PostgreSQL returned the new canonical tenant relations in addition to the legacy expected set.
- **RCA:** The security meta-test intentionally requires an exact table inventory, but the expected map was not extended with the new FORCE-RLS relations.
- **Impact:** False-negative test result; this failure does not itself prove an RLS-policy defect, so the updated exact test must verify every new relation rather than weakening the assertion.
- **Status:** Resolved. The exact canonical tenant-table RLS/index/policy inventory passes.
