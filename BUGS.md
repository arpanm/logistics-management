# Bug and failed-acceptance register

This register tracks the 12 failures from `specs/ALL-FEATURES-E2E-STATUS.md`. RCA is based on real Playwright execution against the locally deployed frontend, backend, and shared PostgreSQL database. All 12 issues are resolved and their affected cases pass in desktop and mobile Chromium.

## Summary

| Bug         | Failed test        | Feature | Classification      | Severity    | Root cause                                                                            | Status   |
| ----------- | ------------------ | ------- | ------------------- | ----------- | ------------------------------------------------------------------------------------- | -------- |
| BUG-E2E-001 | E2E-FOUND-FND01-05 | FND-01  | Product correctness | P1 / Medium | Platform report reads totals and rows from different PostgreSQL snapshots             | Resolved |
| BUG-E2E-002 | OPS02-UI-001       | OPS-02  | Test automation     | P2 / Medium | Brittle exact label locator cannot resolve a visible wrapped select                   | Resolved |
| BUG-E2E-003 | OPS03-UI-001       | OPS-03  | Test automation     | P2 / Medium | Brittle exact label locator cannot resolve a visible wrapped select                   | Resolved |
| BUG-E2E-004 | DOC01-UI-001       | DOC-01  | Test automation     | P2 / Medium | Brittle exact label locator cannot resolve a visible wrapped select                   | Resolved |
| BUG-E2E-005 | FIN02-UI-001       | FIN-02  | Test automation     | P2 / Medium | Brittle exact label locator cannot resolve a visible wrapped select                   | Resolved |
| BUG-E2E-006 | FIN01-UI-001       | FIN-01  | Test automation     | P2 / Low    | Success assertion ambiguously matches two live status regions                         | Resolved |
| BUG-E2E-007 | FIN03-UI-001       | FIN-03  | Test automation     | P2 / Low    | Success assertion ambiguously matches two live status regions                         | Resolved |
| BUG-E2E-008 | E2E-ALT01-01       | ALT-01  | Product integration | P1 / High   | Generic alert records and operational alert queues use disconnected stores            | Resolved |
| BUG-E2E-009 | E2E-ALT01-04       | ALT-01  | Product integration | P1 / High   | Alert action API cannot find records created through the advertised generic API       | Resolved |
| BUG-E2E-010 | E2E-ALT01-05       | ALT-01  | Product integration | P1 / High   | Alert reconciliation reads a store that never received the created alert              | Resolved |
| BUG-E2E-011 | E2E-INT01-01       | INT-01  | Product UI          | P1 / High   | Async form handler loses its form reference and skips state refresh                   | Resolved |
| BUG-E2E-012 | E2E-INT01-04       | INT-01  | Product integration | P1 / High   | Generic delivery records and operational delivery/dead-letter stores are disconnected | Resolved |

## Detailed RCA

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

## Resolution evidence

- **BUG-E2E-001:** Platform totals and tenant rows now come from one materialized PostgreSQL snapshot. The concurrent reconciliation case passes in desktop and mobile Chromium.
- **BUG-E2E-002 through BUG-E2E-005:** Tests use the named combobox role with `selectOption` and verify the chosen value. Each record receives one HTTP 201 and persists exact detail values on desktop and mobile.
- **BUG-E2E-006 and BUG-E2E-007:** Tests target the exact creation-success message while preserving queue/detail checks. Both pass on desktop and mobile.
- **BUG-E2E-008 through BUG-E2E-010:** Alert creation, queue, actions, and reports use the canonical operational alert store with mandatory tenant-scoped idempotency and optimistic versions. Creation, stale recovery, resolution, and reconciliation pass on desktop and mobile.
- **BUG-E2E-011:** The integration form captures its DOM reference before awaiting, reloads canonical state, and displays the new endpoint without navigation. The case passes on desktop and mobile.
- **BUG-E2E-012:** Delivery creation, dead-lettering, replay, detail, and reporting use the canonical integration tables. The regression proves two fail/replay cycles on one delivery, ending at version 5 with replay count 2, in desktop and mobile Chromium.

The backend regression suite also covers required idempotency keys, reordered-body replay, changed-body conflicts, tenant namespacing, stale versions, immutable delivery fields, concurrent failure/replay lock behavior, CSRF, low-capability and cross-tenant denials, payload secrecy, and exact-once audit records.
