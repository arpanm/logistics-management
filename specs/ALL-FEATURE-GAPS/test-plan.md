# ALL-FEATURE-GAPS — Test Plan

**Plan status:** Approved for consolidated implementation
**Overall test status:** Passing
**Requirements source:** `FEATURES.md`

## Scope

This plan closes the difference between passing rapid/generic tests and the domain acceptance criteria in `FEATURES.md`. Every ID below must run against the deployed Next.js frontend, NestJS backend, and shared PostgreSQL service. No network mocks, `page.route`, browser-only business calculations, or direct test writes to business tables may satisfy an ID. Supported deterministic fixture APIs may create prerequisites or control clock/provider outcomes.

FND-01 and FND-02 need no new gap IDs: their dedicated integration and Playwright suites materially cover their acceptance criteria. FND-02 plan/status synchronization remains a documentation task, not an executable gap.

## Historical evidence gaps closed by this batch

| Evidence                                           | Valid proof                                                                                | Missing proof                                                                                                       |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `all-features-foundation-masters.spec.ts`          | Generic location/party/fleet CRUD, isolation, versions, status totals                      | Hierarchy, employees, commercial masters, compliance, eligibility, bank approval, workbook round-trip               |
| `all-features-operations-finance.spec.ts`          | Arbitrary JSON persistence, required HTML fields, isolation, stale versions, status counts | Domain lifecycle, links/snapshots, calculations, ledgers, documents, offline events, approvals, operational reports |
| Operations/POD/finance provider helpers            | Pure calculations and declared invariants                                                  | Production workflows invoke and persist those rules                                                                 |
| `E2E-CTL01-*`                                      | Simple lens/status query and drill-count equality                                          | Required business KPIs, independent reconciliation, three-level drill/export, worst-status and scoped filters       |
| `E2E-ALT01-*`                                      | Manual canonical alert create/action/version/isolation                                     | Threshold engine, scheduler dedupe, routing, auto-resolution, timezone boundaries, channel leasing/retry            |
| `E2E-DAT01-*`                                      | One CLIENT CSV and basic header/job behavior                                               | Seven datasets/XLSX, exact row validation, full-file history, checksum replay, masking/export                       |
| `E2E-GOV01-*`                                      | Generic policy CRUD/version/count                                                          | Documents, visibility comments, approval snapshots/segregation, immutable before/after audit                        |
| `E2E-INT01-*`                                      | Registry and canonical fail/replay/health                                                  | Signed duplicate webhook effect, retry/backoff, secrets, mapping history, notification scope                        |
| `E2E-CFG01-*`                                      | Generic setting CRUD/version/snapshot/count                                                | Real tenant branding/rules, semantic validation, publish/rollback, transaction references, cache invalidation       |
| `rapid-all-features.spec.ts`                       | Route health and one location smoke lifecycle                                              | Any feature-specific acceptance outcome                                                                             |
| `ALL-FEATURES-E2E-STATUS.md` “90 acceptance cases” | Current named assertions passed                                                            | Completion of the corresponding `FEATURES.md` acceptance criteria                                                   |

## Deterministic fixtures

- Two tenants with similar codes but different branding, timezone, currency, thresholds, reasons, and numbering.
- Internal scoped roles, finance maker/checker, vendor, driver, client viewer, integration principal, and denied/suspended actors.
- Fixed instants before/at/after placement, POD, collection, expiry, quiet-hour, and retry boundaries; UTC persistence with tenant-timezone assertions.
- Effective-dated commercial masters, eligible/ineligible fleet, compliance and bank-verification states.
- Exact integer minor-unit and quantity fixtures with expected results calculated independently of production responses.
- Real CSV/XLSX files for all seven datasets; PostgreSQL-backed safe/disallowed document bytes; deterministic signed integration receiver.
- Unique idempotency key per mutation; deliberate same-key replay and same-key/different-input conflict cases.

## Stable test IDs

All 50 IDs are **Passing** in both Chromium and mobile Chromium against the locally deployed frontend, backend, and shared PostgreSQL. The last column maps each gap to its consolidated journey (`XF`) or isolated-risk test (`ISO`).

| Test ID          | True pending behavior                                                                                                                            | Final       |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------- |
| E2E-GAP-MST01-01 | Hierarchy cascades identically through list, dashboard, export, scope and alert recipients; cycles reject                                        | XF-06       |
| E2E-GAP-MST01-02 | Manager deactivation requires reassignment/exception; employee reassignment immediately changes scope and audits                                 | XF-02/XF-06 |
| E2E-GAP-MST02-01 | Client→location→contract→lane/SLA→rate approval, publish, selection and later version                                                            | XF-01       |
| E2E-GAP-MST02-02 | Indent retains effective rate, credit, document and TAT snapshot; overlapping rates reject; inactive selectors preserve history                  | XF-01       |
| E2E-GAP-MST02-03 | Exact Client/Location workbook fields import and export losslessly                                                                               | XF-05       |
| E2E-GAP-MST03-01 | Vendor workbook round-trip and tenant-safe PAN/GSTIN/registration/licence duplicate detection                                                    | XF-05/XF-06 |
| E2E-GAP-MST03-02 | Expired compliance blocks allocation; reasoned override audits; selectors explain exclusions                                                     | XF-01       |
| E2E-GAP-MST03-03 | Bank change is masked, reverified and approved by another actor; vendor portal exposes only own compliance                                       | XF-01/XF-06 |
| E2E-GAP-OPS01-01 | All indent workbook fields round-trip; location is client-filtered; SLA computes commitment; override requires permission/reason                 | XF-01/XF-05 |
| E2E-GAP-OPS01-02 | Manual/import/API duplicate and retry converge to one indent; concurrent edits conflict without overwrite                                        | XF-01/XF-05 |
| E2E-GAP-OPS01-03 | Cancellation updates eligible demand/fill denominator without deleting history                                                                   | XF-02       |
| E2E-GAP-OPS02-01 | Invalid placed/state combinations reject; only eligible active scoped vendor/vehicle/driver choices appear                                       | XF-01/XF-02 |
| E2E-GAP-OPS02-02 | Exact 24h/48h Green/Yellow/Red boundaries agree across preview, queue, alert, dashboard and export                                               | XF-02       |
| E2E-GAP-OPS02-03 | Split allocation totals/fill do not double count; replacement preserves prior assignment and recalculates reports                                | XF-01/XF-02 |
| E2E-GAP-OPS02-04 | Three-level placement dashboard and visible export reconcile to canonical rows                                                                   | XF-02       |
| E2E-GAP-OPS03-01 | Assigned-only small-screen field actions work offline; duplicate API/GPS/offline milestones converge                                             | XF-07       |
| E2E-GAP-OPS03-02 | Ordering conflicts retain device/received time, source, actor and location; active-trip-only location collection                                 | XF-07       |
| E2E-GAP-OPS03-03 | Delivery completion creates one consistent POD task with delivered time and receiver evidence                                                    | XF-03       |
| E2E-GAP-DOC01-01 | Exact 7/15-day and prior-period boundaries; receipt-date stop/correction audit; deduplicated invoice value at risk                               | XF-03       |
| E2E-GAP-DOC01-02 | Safe file type/size/malware/checksum/PostgreSQL/tenant/scope/expiring-access matrix                                                              | XF-03       |
| E2E-GAP-DOC01-03 | POD submission requirements come from the transaction contract snapshot                                                                          | XF-01       |
| E2E-GAP-FIN01-01 | Multi-line taxable/tax/total arithmetic and due date from acknowledged submission plus snapshotted credit days                                   | XF-01       |
| E2E-GAP-FIN01-02 | Duplicate trip/charge billing rejects; posted invoice locks; reversal/note preserves original                                                    | XF-03/XF-04 |
| E2E-GAP-FIN01-03 | Workbook invoice import reconciles receipts or creates auditable openings without invented receipts                                              | XF-05       |
| E2E-GAP-FIN02-01 | Balance is append-only allocation projection; part/full/excess payment policy and duplicate UTR/import idempotency                               | XF-04/XF-05 |
| E2E-GAP-FIN02-02 | Exact 30/31/45/46-day colours and closed state agree across alert, register and dashboard                                                        | XF-04       |
| E2E-GAP-FIN02-03 | Dashboard, invoice/receipt registers, SOA and ledger reconcile; reversal restores balance with linked audit entries                              | XF-04       |
| E2E-GAP-FIN03-01 | Payable line traces to trip/rate snapshot; duplicate invoice/trip billing rejects                                                                | XF-01       |
| E2E-GAP-FIN03-02 | GST/TDS/deductions/advances/payments/outstanding and contribution margin reconcile in minor units                                                | XF-01       |
| E2E-GAP-FIN03-03 | Maker-checker and verified-bank/reapproval rules block unsafe bill/payment approval                                                              | XF-01       |
| E2E-GAP-CTL01-01 | Every placement/POD/collection/trip/payable KPI reconciles to drill rows and independent fixture totals                                          | XF-01       |
| E2E-GAP-CTL01-02 | Worst-child colour/exclusion policy and three-level search/filter/saved-view/breadcrumb/export are consistent/scoped                             | XF-02/XF-06 |
| E2E-GAP-CTL01-03 | As-of/freshness and pause/resume preserve filters/drill; desktop/mobile keyboard and Axe cover controls                                          | XF-02/ISO   |
| E2E-GAP-ALT01-01 | Repeated threshold evaluation creates one linked alert and escalates idempotently at tenant-timezone boundaries                                  | XF-02       |
| E2E-GAP-ALT01-02 | Current owner/hierarchy derives scoped recipients; acknowledgement does not resolve; source repair auto-resolves                                 | XF-03/XF-06 |
| E2E-GAP-ALT01-03 | Quiet-hour channel retries are PostgreSQL-persisted, safely leased, idempotent and observable                                                    | ISO         |
| E2E-GAP-DAT01-01 | CSV and XLSX for all seven datasets round-trip exact fields and cross-file joins                                                                 | XF-05       |
| E2E-GAP-DAT01-02 | Header reorder succeeds; misspelled/duplicate headers and row code/reference/key/date/money/state errors identify exact row/column before commit | XF-05       |
| E2E-GAP-DAT01-03 | Checksum/key replay prevents business/financial duplication; corrected FULL_FILE retains prior values and reconciliation                         | XF-05       |
| E2E-GAP-DAT01-04 | Import authorization and formula-safe masked export match manual UI/API scope                                                                    | XF-06       |
| E2E-GAP-GOV01-01 | Secure versioned documents and internal/client/vendor comment visibility protect bytes, metadata, counts and IDs                                 | XF-03/XF-06 |
| E2E-GAP-GOV01-02 | Approval retains actor/role/time/comment/exact snapshot; material change restarts; maker-checker is server enforced                              | XF-01/XF-03 |
| E2E-GAP-GOV01-03 | Governed audit is immutable and records correct before/after/correlation for edits, overrides and reversals                                      | XF-04       |
| E2E-GAP-INT01-01 | Concurrent signed duplicate event/key has one business effect; conflicting payload rejects                                                       | XF-05       |
| E2E-GAP-INT01-02 | Secrets stay absent from UI/log/error/audit/export and rotate without loss; mappings retain historical payload interpretation                    | ISO         |
| E2E-GAP-INT01-03 | Retry/backoff/lease/dead-letter/replay follows exact versioned policy                                                                            | ISO         |
| E2E-GAP-INT01-04 | Notification recipients/action links enforce tenant and record scope at delivery and click                                                       | XF-06       |
| E2E-GAP-CFG01-01 | Two tenants use different branding/reasons/roles/thresholds/timezone/currency/numbering without leakage                                          | XF-06       |
| E2E-GAP-CFG01-02 | Published config is referenced by transactions; semantic threshold/code/numbering validation rejects ambiguity                                   | XF-01/XF-02 |
| E2E-GAP-CFG01-03 | Rollback creates an audited version without rewriting history; only target tenant cache/projection/session view invalidates                      | XF-01/XF-06 |

## Final consolidated journeys

| Test ID        | Journey                                                                       | Required mapped gaps                                                                                  |
| -------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| E2E-GAP-XF-01  | Contract-to-cash and vendor settlement                                        | Every row mapped to XF-01                                                                             |
| E2E-GAP-XF-02  | Placement breach, escalation, NTP, replacement and recovery                   | Every row mapped to XF-02                                                                             |
| E2E-GAP-XF-03  | Delivery/POD exception blocks then releases billing                           | Every row mapped to XF-03                                                                             |
| E2E-GAP-XF-04  | Collection dispute, short receipt, settlement and reversal                    | Every row mapped to XF-04                                                                             |
| E2E-GAP-XF-05  | Seven-dataset import, correction, replay and cross-file reconciliation        | Every row mapped to XF-05                                                                             |
| E2E-GAP-XF-06  | Tenant/role/scope isolation across records, files, alerts, exports and config | Every row mapped to XF-06                                                                             |
| E2E-GAP-XF-07  | Offline field operation, conflict recovery and location privacy               | Every row mapped to XF-07                                                                             |
| E2E-GAP-ISO-01 | Specialized isolated risks                                                    | CTL01-03 accessibility; ALT01-03 channel lease/retry; INT01-02 secret/mapping; INT01-03 retry/backoff |

Each feature ID remains individually visible as an independently executable test or named `test.step`. Consolidated tests must attach a machine-readable result for every mapped ID and fail the enclosing test if any step fails.

## Required nonbrowser gates

- Clean/upgrade migrations plus FORCE RLS/introspection for every new tenant relation.
- Boundary units for time, exact money, quantity, effective dates, overlap, hierarchy cycles and deduplication.
- Integration/contract tests for legal transitions, idempotency, concurrency, append-only ledgers, approval segregation, file scanning/storage, import transactionality, outbox leasing and audit immutability.
- HTTP authorization matrices for every new list/detail/mutation/report/export/file/action route.

## Execution and acceptance rules

1. Expected totals, money, dates and colours use independent fixture oracles, never another production response.
2. UI performs the primary action in each consolidated journey; supported APIs may arrange prerequisites and verify canonical effects.
3. Every validation, denial, stale version, duplicate, scanner, approval and integration failure asserts no partial mutation.
4. Operational journeys run desktop and mobile; shared interactive patterns receive keyboard and Axe checks.
5. No swallowed assertion, skipped/only test, or N/A caused merely by missing implementation is allowed.
6. Focused gap files must support stable grep by every ID; after focused success run `make e2e` and `make verify`.
7. Only mark a feature complete after every mapped gap and affected cross-feature journey passes and status/spec/TODO evidence is synchronized.

## Approval

- [x] Primary approves gap classification and stable IDs.
- [x] Every `FEATURES.md` acceptance criterion maps to dedicated existing evidence or an ID above.
- [x] Every ID has deterministic real-service fixtures and an independent oracle.
- [x] Existing overclaiming status/descriptions are corrected during synchronization.
- [x] Final focused, full E2E, verification and documentation gates agree.

## Execution evidence — 2026-08-25

- Discovery: 100 gap executions (50 stable IDs × Chromium/mobile Chromium) within 180 active Playwright executions.
- Real-service execution: completed with no mocks, route interception, or direct business-table writes.
- Result: 180/180 passed; all 50 gap IDs passed in both browser projects.
- Classification: Passing. FND-02 prerequisite regressions BUG-GAP-003 and BUG-GAP-004 and security/correctness gaps BUG-GAP-006 through BUG-GAP-012 are resolved.
