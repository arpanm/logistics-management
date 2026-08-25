# All-feature production gap audit

**Status:** Approved implementation input
**Scope:** FND-01, FND-02, MST-01, MST-02, MST-03, OPS-01, OPS-02, OPS-03, DOC-01, FIN-01, FIN-02, FIN-03, CTL-01, ALT-01, DAT-01, GOV-01, INT-01, CFG-01
**Method:** Read-only comparison of `FEATURES.md` to the production migrations, NestJS services/controllers, shared manifests/providers, and Next.js routes. No tests were run. Existing tests prove only the behavior they execute and are not treated as evidence for unexercised requirements.

## 1. Executive finding

The foundation and identity modules contain substantial real behavior, and alerts, imports, and integration delivery have dedicated PostgreSQL stores. The remaining product is not yet an end-to-end logistics platform. Most master, operations, POD, finance, governance, and configuration routes persist arbitrary JSON through `app.module_records`; the named provider files primarily export manifests, arithmetic helpers, and invariant strings and are not called by the HTTP request path.

The generic kernel is useful scaffolding, but it does not implement the documented relationships, domain validation, workflow guards, authorization scopes, calculations, ledgers, reports, alerts, files, or cross-feature events. This is visible in:

- `apps/backend/src/modules/kernel/kernel.controller.ts:20-47`, where the generic request schemas validate only envelope shape and accept arbitrary `data`.
- `apps/backend/src/modules/kernel/kernel.controller.ts:79-100`, where resource capability checks exist only for canonical alerts and integration deliveries; every other kernel resource relies only on internal-membership checks.
- `apps/backend/src/modules/kernel/kernel.service.ts:204-305`, where generic creation inserts JSON without executing the operations, POD, finance, master, governance, or configuration providers.
- `apps/backend/src/modules/kernel/kernel.service.ts:415-495`, where a transition need only target any status in the manifest; allowed from/to edges, conditional fields, maker-checker rules, and immutable financial states are not enforced.
- `apps/backend/src/modules/kernel/kernel.service.ts:498-520`, where every generic report is only a status count.
- `packages/db/prisma/migrations/202608250004_module_kernel/migration.sql:3-89`, which contains generic records, metadata-only documents, comments, snapshots, and workflow events but no normalized master, logistics, POD, approval, or financial ledger relationships.
- `apps/frontend/app/app/operations/_components/transaction-workspace.tsx:69-88,183-243`, where forms write string-valued JSON, queue names are display text, detail is raw JSON, and reports are browser-side status counts.

No existing production behavior should be discarded. The canonical alert and delivery remediation, FND-01/FND-02 security controls, RLS, idempotency patterns, audit append-only rules, and PostgreSQL-only infrastructure are prerequisites to reuse.

### Severity summary

| Feature | High — blocks the documented primary workflow or security/accounting truth                                              | Medium — leaves a documented supporting UX/report/alert incomplete         |
| ------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| FND-01  | Invitation delivery state is asserted without delivery; later resources lack automatic isolation coverage               | Setup prerequisites and platform integration health are incomplete         |
| FND-02  | Real business resources bypass capability/scope evaluation and masking; portals are probe-only                          | Role home is not work-queue driven                                         |
| MST-01  | Organization/employee/geography relationships, cycle checks, assignments, and deactivation safety are absent            | Ownership reports and orphan alerts are absent                             |
| MST-02  | Contracts, lanes, SLAs, rate versions, overlap rules, and transaction snapshots are absent                              | Directory/expiry/coverage/change reports and alerts are absent             |
| MST-03  | Secure bank, compliance, eligibility, override, and allocation enforcement are absent                                   | Capacity/compliance reports, alerts, and vendor self-service are absent    |
| OPS-01  | Typed validation, SLA snapshot/default, governed lifecycle/cancellation, and create idempotency are absent              | Operational queues/reports/alerts are labels only                          |
| OPS-02  | Split allocation, offer response, eligibility, conditional placement, and replacement history are absent                | Risk/fill/vendor/delay intelligence is absent                              |
| OPS-03  | Append-only trip events, assigned mobile actions, offline/GPS ingestion, privacy, and POD handoff are absent            | Live-trip reports and alerts are absent                                    |
| DOC-01  | Delivery handoff, enforced review workflow, PostgreSQL file bytes/access, and persisted ageing/value-at-risk are absent | POD reports and alerts are absent                                          |
| FIN-01  | Billable-service joins, server calculations, approval/posting immutability, and adjustments are absent                  | Billing reports and alerts are absent                                      |
| FIN-02  | Append-only receipt/allocation/reversal ledger and reconciliation rules are absent                                      | Collection queues, SOA/reports, and alerts are absent                      |
| FIN-03  | Payable lines, three-way validation, segregation, verified-bank payment, and reversals are absent                       | Payable/ledger/margin reports and alerts are absent                        |
| CTL-01  | Lens resource mappings are disconnected and KPI/filter/drill results are not computed                                   | Saved views, breadcrumbs, exports, and complete responsive UX are absent   |
| ALT-01  | Rule configuration is disconnected; evaluator/routing/auto-resolution/channel delivery do not exist                     | Full queue actions, detail, filters, and analytics are absent              |
| DAT-01  | XLSX/real CSV parsing, row validation, typed command dispatch, financial safety, and correction semantics are absent    | Templates, mapping/error download, export, and freshness alerts are absent |
| GOV-01  | Secure file lifecycle, audience-aware comments, approval instances, segregation, and before/after audit are absent      | Record tabs, reports, alerts, and audit export are absent                  |
| INT-01  | Machine auth, signed webhook ingestion, executable delivery retry, secret rotation, and mapping history are absent      | Notification/GPS/accounting adapters and complete health UX are absent     |
| CFG-01  | Configuration stores are disconnected; typed publish/version/snapshot/rollback behavior is absent                       | Complete branding, impact/diff reports, and alerts are absent              |

## 2. Cross-cutting blocking gaps

### GAP-X-01 — Domain authorization is disconnected from FND-02

All master, operations, POD, finance, governance-policy, configuration, control drill, and import target records must call the centralized capability and scope evaluator at service/query boundaries. `assertInternal()` is not sufficient. Queries must derive legal-entity, region, branch, client, location, vendor, and assigned-trip predicates from the authenticated membership. Exports, reports, alerts, documents, and portals must use the same predicate. Sensitive JSON cannot be returned wholesale: PAN, GSTIN, mobile, bank, commercial rate, margin, and payment fields require field-level projection/masking.

Acceptance impact: every FND-02 role/scope, direct-API denial, effective-preview parity, and masking criterion; every feature's isolation and permission-aware report/export criterion.

### GAP-X-02 — Manifests are descriptions, not executable domain rules

The manifests in `apps/backend/src/modules/operations/manifest.ts`, `pod/manifest.ts`, and `finance/manifest.ts` list fields and transitions, but the generic API neither validates those fields nor invokes the exported calculations/invariants. Introduce typed resource commands and schemas, normalized foreign keys, conditional validation, allowed-edge workflow guards, and feature events. Keep `module_records` only for genuinely configurable metadata or as a transition bridge; it must not be the financial or event system of record.

Acceptance impact: all workflow, reference-integrity, boundary-calculation, historical-reproducibility, and reconciliation criteria from MST-01 through FIN-03.

### GAP-X-03 — Generic audit and files do not satisfy governed evidence

Generic audit calls omit before/after payloads, generic comments have no visibility/edit history/resolution, and `app.module_documents` stores only an `object_key`, not document bytes or the specified metadata. There is no authorized download route, expiry token, malware/type verification state, or external visibility policy. Implement GOV-01 primitives once and consume them from masters, operations, POD, and finance.

Acceptance impact: GOV-01 in full; document, approval, attachment, correction, and audit requirements throughout the product.

### GAP-X-04 — Reports, alerts, exports, and events are mostly labels

Generic pages print queue/report names, while the generic report API groups only by status. Domain changes do not publish the specified canonical events or invoke alert adapters. CTL-01 therefore cannot reconcile to canonical detail, ALT-01 cannot evaluate most baseline conditions, and DAT-01/INT-01 cannot safely drive typed domain commands.

Acceptance impact: every feature's Reports and alerts section and cross-feature journeys E2E-01 through E2E-07.

## 3. Feature-by-feature traceability

### FND-01 — Multi-tenant product foundation

Implemented evidence: protected provisioning, legal entity/default configuration creation, owner membership/invitation records, idempotency, lifecycle, tenant switching, RLS, setup context, platform health and alerts exist in `apps/backend/src/app.service.ts`.

Concrete gaps:

1. Provisioning marks an active tenant's invitation and outbox event `DELIVERED`/`PROCESSED` inside the provisioning transaction without a delivery adapter (`app.service.ts:671-700`). It proves one durable invitation, not that an invitation was sent exactly once. Add a PostgreSQL-leased delivery attempt/result and expose pending/failed delivery without falsely claiming delivery.
2. Seven setup areas are created as `NOT_AVAILABLE`, and the API rejects every checklist update except branding (`app.service.ts:582-600,1063-1076`). Connect checklist state to completed organization, user, branch, client, vendor, commercial, import, and branding prerequisites.
3. Platform integration health is hard-coded to `Not configured` (`app.service.ts:1313-1327`) instead of aggregating the INT-01 canonical endpoint/delivery store. Platform alerts cover provisioning and repeated job failures but not a generalized tenant-scope/storage invariant signal.
4. FND-01 isolation is proven for foundation/probe resources, not automatically for every later tenant table/resource. Add a catalog-driven isolation check when each canonical table is introduced.

Required acceptance trace: owner invitation exactly-once; complete setup checklist; tenant switch state reset; deactivate/reactivate jobs; all-table UI/API/job/document/report/export isolation.

### FND-02 — Identity, roles, and scoped access

Implemented evidence: invitations, roles/capabilities, scope nodes/grants, session invalidation, MFA/recovery, access preview, reports/alerts, denial audit, masking examples, and limited probe portals are implemented in `access.service.ts` and `access.controller.ts`.

Concrete gaps:

1. FND-02 authorizes authorization-probe records, but the generic business kernel does not call it except for alerts/delivery capability checks (`kernel.controller.ts:79-100`). Integrate capability/action and scoped-resource evaluation into every canonical business query and mutation.
2. Vendor, driver, and client portal routes all render the same authorization-probe UI (`apps/frontend/app/portal/*/page.tsx`); they do not expose vendor allocations/trips/payments/compliance, driver assigned trip actions, or client scoped records.
3. Generic record detail/list returns the entire `data` JSON (`kernel.service.ts:149-201,308-355`), so future sensitive master/finance fields would bypass masking.
4. Role-appropriate home currently links only to probes and access management (`apps/frontend/app/app/page.tsx:16-23`), rather than effective work queues and permitted modules.

Required acceptance trace: Regional Manager region scope, KAM client scope, vendor/driver assigned-resource scope, non-leaking denial audit, immediate scope invalidation, preview/runtime parity on real resources, and secondary-channel masking.

### MST-01 — Organization, employee, and geography masters

Implemented evidence: one generic `locations` resource supports a type, parent code, address, timezone, effective dates, status, comments, and document metadata.

Concrete gaps:

1. There are no canonical legal-entity hierarchy, region, branch, team, employee, manager, linked-user, active-date, geography, coordinate, postal, or geofence models. The UI manifest has only four location fields (`apps/frontend/components/module-kit/manifests.ts:42-63`).
2. `parentCode` is unchecked JSON, so missing parents and hierarchy cycles are accepted. No hierarchy closure/path exists for cascading authorization and filters.
3. KAM/client, manager/location, and traffic/queue assignments, bulk assignment, deactivation impact preview, reassignment/exception, and orphan escalation do not exist.
4. The only report is status count; organization tree, ownership, unowned record, inactive-owner reports, and orphan alerts are absent.

Required acceptance trace: cascading hierarchy filters across list/dashboard/export/alert; required reassignment or exception; cycle rejection; audited effective-scope update.

### MST-02 — Client, contract, lane, SLA, and rate-card masters

Implemented evidence: generic `parties` captures party type, tax identifier, email, mobile, and address with an active/inactive lifecycle.

Concrete gaps:

1. The specified Client Master and client-location fields are absent, including industry, billing entity, account manager, escalation contacts, credit days, POD mode, location type/managers/mobile/geofence, and code immutability.
2. Contracts, attachments, lanes, SLA rules, truck/cargo/quantity dimensions, placement/transit/POD TATs, service windows, client rate lines, charge rules, approval/publish/version states, and overlap/priority validation do not exist.
3. No resolver selects an effective published contract/SLA/rate at indent time, and no immutable commercial snapshot can protect existing transactions from later master changes.
4. Expiry, draft/missing/overlap/SLA-coverage/change-history reports and alerts are absent. Workbook round-trip is impossible because DAT-01 stores raw rows but manual UI/model omits most columns.

Required acceptance trace: create/approve/publish/version full commercial chain; deterministic effective snapshot; overlap rejection; inactive selector/history behavior; exact Client and Location workbook round-trip.

### MST-03 — Vendor, vehicle, driver, and compliance masters

Implemented evidence: generic `fleet` stores asset type, registration, vendor code, capacity, and one expiry date. Vendor is only a generic party.

Concrete gaps:

1. Most Vendor Master fields and normalized vendor service regions/lanes, PAN/GSTIN duplicate handling, onboarding employee reconciliation, TDS/MSME/payment terms, and secured bank accounts are absent.
2. Vehicle/driver models lack ownership, make/model/year, permits, insurance, fitness, pollution/tax documents, GPS device, licence class/validity, KYC, emergency contact, allowed vehicle, safety status, and portal identity.
3. There is no document-level compliance verification, grace policy, eligibility decision/reason API, governed override, or allocation integration.
4. Bank re-verification and dual control do not exist; neither do capacity/compliance/block/onboarding/bank-change reports and expiry alerts. Vendor portal is a probe shell.

Required acceptance trace: Vendor workbook round-trip; tenant-safe duplicate candidates; expired-document block/override audit; masked maker-checker bank change; own-vendor compliance portal.

### OPS-01 — Indent capture and lifecycle

Implemented evidence: an indent manifest, a generic create page, JSON persistence, versioned generic edits, and status membership exist. Arithmetic/date helpers exist in `operations/provider.ts` but are not invoked.

Concrete gaps:

1. The API accepts arbitrary `data`, does not resolve client/location/contract/lane, and does not validate requested quantity, pickup windows, workbook fields, or client-location ownership. The UI omits copy, attachments, contract/lane, source/reference, cargo/body, cancellation detail, and several workbook fields.
2. Commitment is user-entered; no effective SLA/location TAT lookup, computed default, governed override permission/reason/approval, or rate/SLA/document snapshot exists.
3. The declared transition graph is not enforced; any manifest status can be selected through the API. Cancellation quantity, confirmation, vendor-cost policy, and fill-denominator event are absent.
4. Generic creates are not idempotent despite the manifest claim; the controller passes a key but the generic service ignores it. No ownership queue, demand/cancellation/override/source report, or submitted/commitment/unowned alert adapter exists.

Required acceptance trace: exact workbook support; filtered location and computed/overridden commitment; duplicate/idempotent manual/import/API create; cancellation denominator/history; concurrent edit safety.

### OPS-02 — Vendor allocation and placement

Implemented evidence: allocation fields/statuses are declared; pure `placementColour()` and `allocationTotals()` functions exist (`operations/provider.ts:16-45`). A generic JSON form/list exists.

Concrete gaps:

1. No relational allocation-to-indent model, split quantity constraint, remaining-demand lock, offered vendor-cost snapshot, offer expiry/response command, or vendor portal action exists.
2. Vendor/vehicle/driver selectors are plain text and do not evaluate active state, service scope, compliance, capacity, double assignment, or explain exclusions.
3. Placed/awaited/NTP conditional validation is not enforced. Vehicle replacement is an overwriteable JSON field with no append-only assignment history.
4. Placement clock/variance/colour helpers are disconnected; risk ordering, pre-breach/breach/offer/rejection/NTP/replacement alerts, fill/vendor/delay reports, and three-level reconciled dashboard are absent.

Required acceptance trace: conditional placement validation; eligible explainable selectors; exact 24/48-hour boundaries; partial allocation reconciliation; replacement history; three-level dashboard reconciliation.

### OPS-03 — Trip execution, loading, transit, and unloading

Implemented evidence: trip fields/status labels and a pure in-memory deduplication helper exist. The UI creates one generic trip JSON record.

Concrete gaps:

1. There are no trip milestone/event tables, planned milestones, LR generation, append-only device/source events, event ordering conflict records, ETA engine, or delivery-completed outbox event.
2. Loading, driver, and unloading role-specific mobile flows do not exist. Driver portal is a probe shell; no assigned-trip brief/actions, location consent window, navigation/checklist, checkpoint, exception, or SOS behavior exists.
3. GPS/manual ingestion, coordinates/speed/odometer/stoppage/route-deviation normalization, privacy-limited tracking, and GPS freshness are absent.
4. No browser offline queue/sync state exists. The helper deduplicates only an in-memory array and is not a PostgreSQL idempotency boundary. Live map/milestone/TAT/detention/completeness reports and all trip alerts are absent.

Required acceptance trace: intermittent mobile assigned action; duplicate event suppression; retained ordering conflict metadata; DOC-01 delivery handoff; no location capture outside active assignment.

### DOC-01 — POD and delivery-document workflow

Implemented evidence: POD fields/status labels and pure ageing/colour/value-at-risk helpers exist (`pod/provider.ts:5-30`). Generic record/document metadata can be inserted.

Concrete gaps:

1. Delivery completion does not create a POD task. There is no relational LR/trip/indent/client/location/multi-invoice model or duplicate-row import representation.
2. The declared review/correction/submission transition graph and conditional requirements are not enforced. The transaction workspace exposes create/list only, not lifecycle actions.
3. Document bytes are not stored; malware/type/size checks, OCR confirmation, versioning, confidentiality, expiring authorized download, signature/OTP evidence, and discrepancy handling are absent.
4. Ageing/carryover/value-at-risk helpers are disconnected from persistence and tenant configuration. POD reports, threshold/carryover/missing-evidence/rejection/received-not-submitted alerts, and contract-snapshot submission requirements are absent.

Required acceptance trace: 7/15-day and carryover boundaries; receipt-date stop/correction audit; invoice-value deduplication; secured PostgreSQL bytes/download; contract-derived submission requirement.

### FIN-01 — Client billing and invoice workflow

Implemented evidence: invoice fields/status labels and pure invoice/due-date functions exist (`finance/provider.ts:3-19`). Generic records accept minor-unit-looking fields.

Concrete gaps:

1. There is no unbilled-service eligibility query, POD/document/exception gate, trip/LR join, client rate snapshot, charge/tax/credit line model, or margin permission.
2. Taxable, tax, total, credit days, and submission values are client-supplied strings in JSON. `calculateInvoice()` and `calculateDueDate()` are not called by API persistence.
3. No approval instance/maker-checker, immutable posting/numbering constraint, billable-service uniqueness, credit/debit note, compensating reversal, acknowledgement evidence, or accounting-export event exists. Generic update can replace all invoice JSON in any state.
4. All billing reports and alerts are labels only. Workbook opening invoice reconciliation is a raw generic upsert and can invent editable summary values.

Required acceptance trace: exact line/tax total; acknowledgement-based due date; duplicate billing prevention; post immutability/adjustment; opening reconciliation without invented receipts.

### FIN-02 — Receipts, reconciliation, and collections

Implemented evidence: receipt field/status labels and pure balance/colour helpers exist (`finance/provider.ts:21-61`).

Concrete gaps:

1. There are no append-only receipt, allocation, deduction, on-account, reversal, invoice-balance, bank-account, reconciliation, follow-up, or promise-to-pay tables.
2. Many-to-many allocation and exact remaining balance are not enforced. Duplicate receipt/UTR, conditional instrument/deduction rules, over-allocation policy, and maker-checker reconciliation are absent.
3. Generic record update permits direct editing of receipt/payment summary JSON and transitions are not constrained, violating the append-only financial rule.
4. Collection priority, ageing, SOA, follow-up productivity, receipt/invoice reconciliation, broken-promise/no-follow-up/deduction alerts, and dashboard ledger reconciliation are absent.

Required acceptance trace: ledger-derived balances; partial/full/on-account behavior; duplicate/idempotent posting; 30/45-day boundaries; report/SOA reconciliation; compensating reversal.

### FIN-03 — Vendor bills, deductions, and payments

Implemented evidence: vendor-bill fields/status labels and pure payable/margin functions exist (`finance/provider.ts:64-89`).

Concrete gaps:

1. There is no unbilled vendor-service eligibility, trip/rate-snapshot payable line, duplicate trip/vendor-invoice constraint, three-way validation, variance exception, or vendor bill portal/import command.
2. GST/TDS/deduction/advance/payable totals are client-supplied JSON; server calculations are disconnected.
3. Operational verification, finance approval, maker-checker segregation, verified bank snapshot, payment batch/allocation, UTR lifecycle, failure/reversal compensation, and remittance advice do not exist.
4. Vendor ledger/payable/margin/tax/payment reports and the specified missing/rate/compliance/approval/due/bank/failure/dispute alerts are absent.

Required acceptance trace: trip/rate traceability; duplicate prevention; exact payable reconciliation; segregation; verified-bank enforcement; reproducible contribution margin.

### CTL-01 — Control tower dashboards and drill-down reports

Implemented evidence: a lens selector, live/pause timer, as-of/freshness display, KPI code catalog, and status/drill endpoints exist.

Concrete gaps:

1. Lens mappings use singular/nonexistent resource types such as `indent`, `allocation`, `trip`, `pod_task`, and `client_invoice`, while the generic records use `indents`, `allocations`, `trips`, `proofs`, and `invoices` (`control.provider.ts:10-16` versus kernel manifests). Existing canonical records therefore do not feed these lenses.
2. The dashboard returns only `{records}` plus status counts; every documented KPI renders `—` (`control.provider.ts:31-50`, `control/page.tsx:85-90`). No placement/POD/collection/trip/payable calculation or worst-child status exists.
3. Supplied filters are echoed but never applied. The drill endpoint is a flat raw-record list; no three-level hierarchy, breadcrumbs, scoped search, saved-view CRUD/default, visible-scope export, or export audit exists. `app.control_saved_views` is unused by any route.
4. Module-accessible tabs, tenant timezone/as-of query, delayed/partial/failed freshness classification, and responsive keyboard drill/table behavior are incomplete.

Required acceptance trace: KPI/detail/database reconciliation; worst-status policy; consistent filter/search/saved-view/breadcrumb/export; refresh state preservation; responsive keyboard UX.

### ALT-01 — Alerts, escalation, and work queues

Implemented evidence: canonical occurrence/action persistence, deduplication, versioned actions, list/detail/report, idempotency, audit, and basic acknowledge/resolve UI are real.

Concrete gaps:

1. `app.alert_rules` has no specialized CRUD/publish API or UI. The generic `alerts.alert_rule` path writes `app.module_records`, so configured rules are disconnected from the canonical rule table.
2. There is no PostgreSQL-leased evaluator, schedule/event adapters, threshold/timezone boundary engine, ownership/hierarchy recipient resolver, severity escalation, repeat/quiet-hour policy, source-condition auto-resolution, or implementation of the baseline alert catalog.
3. No alert notification outbox/delivery attempt/channel retry exists. Integration delivery records are not an alert-channel lifecycle and do not prove recipient delivery.
4. Queue UI lacks source-record detail/evidence navigation, owner/client/location/age/last/next fields, assign/comment/snooze/escalate actions, filters, and analytics. Canonical report is limited to state/severity counts.

Required acceptance trace: one open occurrence across repeated evaluation; exact boundary; tenant/scope-safe ownership/escalation; acknowledge versus source resolution; idempotent observable channel retries.

### DAT-01 — Bulk import, validation, correction, and export

Implemented evidence: seven dataset names, CSV preview, checksum replay, required/duplicate header checks, row/error/job persistence, optimistic commit, and generic create/update disposition counts exist.

Concrete gaps:

1. UI accepts CSV only and parses with `split(',')`, so quoted commas/newlines/escaping are incorrect and `.xlsx` is unsupported (`data/page.tsx:40-57,142-144`). There are no template download or mapping controls.
2. Profiles list only a subset of required headers (`data/manifest.ts:56-104`). Preview validates headers only; it does not validate row types, exact dates/timestamps/money, code lists, computed colour rejection, cross-references, uniqueness, permissions, or state combinations. Unknown headers are reported but do not fail.
3. Commit writes raw rows directly to generic records, bypassing canonical feature commands, domain authorization, financial posting, audit events, and normal workflows (`data.provider.ts:193-263`). Natural key/name are inferred from the first two object values, which is unsafe when header order changes.
4. FULL_FILE does not deactivate/report missing records, correction lineage is unused, created rows lack full snapshots/events/audit, error download is absent, and there is no current-view/full export or masking parity. Freshness/abnormal-count/reference alerts are absent.

Required acceptance trace: seven exact round-trips; order-independent mapping and early header failure; exact row/column failures; idempotent business/financial effects; correction history; manual/import authorization and masking parity.

### GOV-01 — Documents, comments, audit, and approvals

Implemented evidence: generic metadata-only document rows, comments, record snapshots/workflow events, immutable audit table, and a generic policy record lifecycle exist.

Concrete gaps:

1. Document model lacks bytes, category, issue/expiry, source, verification/malware state, confidentiality, retention, version relationship, and authorized download token. Client-supplied `objectKey` is accepted without storage or content verification (`kernel.controller.ts:41-47`; `kernel.service.ts:561-605`).
2. Comments lack mentions, attachments, audience visibility, edit history, resolution, and external filtering.
3. Governance policies are untyped JSON records. There are no approval definitions with executable thresholds/steps, approval instances, exact submitted snapshots, actor-role decisions, delegation/expiry, material-change invalidation, or maker-checker enforcement.
4. Generic audit events do not include before/after values for updates/transitions. There is no record tab suite, audit viewer/filter/export, approval/document reports, or governance alerts.

Required acceptance trace: secure PostgreSQL file lifecycle; exact approval decision snapshot; segregation; immutable before/after audit; external visibility isolation.

### INT-01 — APIs, notifications, GPS, accounting, and migration connectors

Implemented evidence: endpoint registry, secret-reference field, canonical delivery/dead-letter persistence, idempotent failure recording, replay, health/list/report routes, audit, and a basic admin UI exist.

Concrete gaps:

1. There is no API-client credential issuance/rotation, scoped machine authentication, signed inbound webhook controller, signature/event validation, public versioned schemas, correlation/pagination contract enforcement, or rate-limit implementation.
2. Delivery rows can be recorded and replayed, but no PostgreSQL lease executor performs outbound delivery/backoff. Endpoint retry/rate policies are stored but not executed; success/failure transitions are not driven by an adapter.
3. Notification templates, recipient resolution/action links, in-app/email/SMS/WhatsApp adapters, GPS normalization/freshness, accounting posted-document exchange/reconciliation, and safe migration adapter contracts are absent.
4. Mapping version is a mutable endpoint integer with no mapping-version history or retained auditable payload envelope. UI forces empty scopes/events and mapping version 1 and omits retry/rate configuration (`integrations/page.tsx:62-75`). Health lacks latency, throughput, rate use, schema/auth failure, and reconciliation views/alerts.

Required acceptance trace: one effect per event key; secret absence/rotation; executable retry/backoff/dead-letter; historical mapping audit; tenant/record-scoped recipients/action links.

### CFG-01 — No-code tenant configuration and white-labeling

Implemented evidence: FND-01 stores five tenant configuration namespaces; a separate generic effective-dated `configuration.settings` resource accepts namespace/value JSON and snapshots generic edits.

Concrete gaps:

1. The two configuration stores are disconnected. Publishing a generic setting does not update tenant branding/locale/module behavior, selectors, reason/code lists, thresholds, documents, numbering, approvals, or projections.
2. Branding fields are incomplete (logo, support/document/email/portal labels), and frontend shell state is not demonstrably sourced/invalidation-versioned for all tenant configuration.
3. There is no typed schema registry, draft/preview/impact/publish workflow, overlap/duplicate-code/threshold/numbering validation, effective version resolution, transaction snapshot reference, or rollback-as-new-version command.
4. Configuration diff/override/deprecated-code/impact reports and publish/financial/integration/deprecation alerts are absent.

Required acceptance trace: distinct tenant behavior without forks; reproducible transaction config; invalid-range/code/pattern rejection; audited non-rewriting rollback; tenant-local cache/projection invalidation.

## 4. Smallest coherent implementation batches

These five batches minimize duplicated infrastructure while respecting dependency direction. A batch is complete only when its listed feature criteria use canonical data rather than generic-label evidence.

### Minimum complete next batch

Complete **MST-01 plus real-resource FND-02 enforcement** first. This is the smallest dependency-ready slice that can finish a feature rather than add more scaffolding: normalized organization nodes/closure, employees, geography/geofence and assignments; cycle/deactivation/reassignment rules; capability/scope predicates and masked projections on those resources; hierarchy/ownership reports; orphan alert occurrence; and the hierarchy/employee/assignment UI. It should own a single forward migration, typed Nest module/routes, MST-01 pages, and focused tests. It must not attempt contracts, fleet, operations, finance, or the generic GOV/CFG redesign. Its output becomes the proven authorization and hierarchy contract used by every later batch.

### Batch A — Governed platform and authorization spine

**Features:** FND-01, FND-02, GOV-01, CFG-01 cross-cutting completion.

**Data requirements:** PostgreSQL document bytes and document versions/access grants; comment visibility/history; approval definitions/instances/steps/decisions/snapshots; typed configuration drafts/versions/publications; configuration cache/version marker; durable invitation delivery attempt; setup prerequisite projection. Extend audit writes with before/after and impersonation context. All new tenant tables require composite tenant foreign keys, tenant-leading indexes, ENABLE/FORCE RLS, and catalog isolation coverage.

**Backend/API requirements:**

- A reusable `authorizeResource(actor, capability, canonicalScope)` and field-mask projection consumed by every later module.
- `/tenant/documents/...` upload/download/verify/version endpoints backed by PostgreSQL bytes and expiring authorization.
- `/tenant/comments/...`, `/tenant/approvals/...`, and `/tenant/audit...` reusable scoped APIs.
- `/tenant/configuration/drafts|preview|publish|rollback|versions|impact` and typed namespace schemas.
- Real setup prerequisite status and platform integration-health aggregation.

**Frontend requirements:** reusable Details/Documents/Comments/Approvals/Audit tabs; typed configuration editors/preview/impact/diff; role-derived landing/navigation; portal shell contracts that later batches populate.

### Batch B — Canonical organization, commercial, and supply masters

**Features:** MST-01, MST-02, MST-03.

**Data requirements:** normalized organization nodes/closure, employees/manager links, geography/geofence, operational assignments; clients/client locations; contracts/versions, lanes/SLA rules, client rate cards/lines and immutable published versions; vendors, service scopes, bank versions/verification, vehicles, drivers, compliance requirements/documents, eligibility decisions/overrides. Use effective dates and canonical natural-key uniqueness.

**Backend/API requirements:** typed CRUD and selectors; hierarchy-cycle/deactivation-impact commands; assignment/bulk assignment; contract/rate approve/publish/version and effective resolver; overlap detection; duplicate candidate API; bank maker-checker; compliance eligibility/explanation; workbook DTO adapters; scoped reports and alert events.

**Frontend requirements:** hierarchy/tree and impact/reassignment flows; client/location/contract/lane/SLA/rate editors; vendor onboarding, bank verification, vehicle/driver/compliance screens; own-vendor compliance portal.

### Batch C — Contract-to-delivery execution

**Features:** OPS-01, OPS-02, OPS-03, DOC-01.

**Data requirements:** indents plus commercial/SLA/config snapshots; cancellations; allocations/offers/responses; append-only vehicle/driver assignments; trips/planned milestones/immutable events/offline conflicts/GPS normalization; POD tasks, LR-to-invoice links, review/submission/discrepancy states. Use outbox events for submitted indent, placement, trip delivery, and POD changes.

**Backend/API requirements:** idempotent typed commands for indent manual/copy/import/API create, submit/cancel/override; split allocation and offer response; eligibility selectors and replacement; milestone/offline/GPS ingest; role-assigned mobile actions; delivery-to-POD consumer; POD review/correction/submission; placement/POD boundary calculators wired to persisted queries; all queues/reports/alerts.

**Frontend requirements:** client-filtered selectors and computed previews; risk queue and vendor offer portal; loading/driver/unloading small-screen flows with offline sync; POD document/review/submission workspace; genuine reports and exception recovery.

### Batch D — Immutable finance and settlement ledgers

**Features:** FIN-01, FIN-02, FIN-03.

**Data requirements:** billable/unbilled services; client invoice headers/immutable lines/taxes/service links/notes/reversals; receipts and append-only allocation/deduction/on-account/reversal entries; collection follow-ups/promises; vendor bill/rate lines/validation; payment batches/allocations/reversals/remittance. Money is bigint minor units or exact decimal only; unique constraints prevent duplicate service billing and duplicate external references.

**Backend/API requirements:** eligibility and exact calculation services; approval integration; post/acknowledge/reverse/note commands; receipt allocation/reconciliation/reversal; vendor three-way validation and bank-snapshot payment; accounting outbox; ledger-derived report APIs and alert adapters. Generic PATCH must be unavailable after financial posting.

**Frontend requirements:** unbilled selection/charge preview; approval/posting/acknowledgement; receipt allocator and prioritized collections; vendor validation/payment run/remittance; reconciled invoice, receipt, SOA, vendor ledger, ageing, tax, and margin reports.

### Batch E — Canonical intelligence and external edges

**Features:** CTL-01, ALT-01, DAT-01, INT-01.

**Data requirements:** reusable reporting queries/projections derived from B-D canonical tables; saved views; connected alert rules/evaluations/occurrences/deliveries; import templates/mappings/corrections/reconciliation; API clients/webhook events; integration mapping versions; delivery leases/attempts; notification/GPS/accounting reconciliation. Reuse PostgreSQL jobs/outbox/leases only.

**Backend/API requirements:** correct lens resources and calculated KPIs/drills/exports; rule CRUD/evaluator/recipient/escalation/auto-resolution/channel delivery; server-side XLSX/CSV parser and seven typed import adapters that invoke normal commands; template/error/export endpoints; scoped machine auth and signed webhook ingest; executable adapter/lease/retry lifecycle; notification, GPS, accounting, and migration interfaces with safe adapters.

**Frontend requirements:** filters, saved views, breadcrumbs, exact-scope download, data freshness states; full alert rule/queue/detail/actions/analytics; XLSX/CSV mapping/error/correction/reconciliation; integration scopes/events/rate/retry/mapping configuration and health/reconciliation.

## 5. API and persistence rules for every batch

1. Tenant context is session/credential derived; client tenant IDs are never authoritative.
2. Each command has a strict typed schema, idempotency semantics where retried, optimistic version where mutable, and a single transaction containing domain rows, audit, and outbox state.
3. Canonical foreign keys include tenant identity. JSON may hold extensible attributes but must not replace relationships, money ledgers, event ordering, approval state, or required validation.
4. List/report/export/alert/document paths share the same scoped authorization predicate and mask projection.
5. Financial posting, trip events, assignments, audit, approvals, and integration delivery attempts are append-only; correction uses explicit compensating/version records.
6. Timestamps are UTC, tenant timezone is explicit for calendar and threshold rules, and calculations expose the configuration/snapshot version used.
7. Local infrastructure remains Next.js + NestJS + the central shared PostgreSQL container only.

## 6. Completion traceability

This gap audit is an implementation input, not completion evidence. A feature can move from In progress only after its own approved spec/test plan demonstrates every `FEATURES.md` acceptance criterion and its reports/alerts/exports against the canonical store. In particular:

- Batch A closes GAP-X-01 and GAP-X-03 and supplies reusable authorization/governance/configuration contracts.
- Batch B supplies the effective-dated and eligibility inputs required by B-D.
- Batch C closes the operational lifecycle and emits canonical delivery/POD evidence.
- Batch D replaces editable financial JSON with reconciled ledgers.
- Batch E closes GAP-X-04 and must consume, never re-create, B-D business truth.

Existing generic-kernel E2E cases may remain as smoke tests, but they cannot be the sole acceptance evidence for a feature whose documented workflow, relationship, calculation, alert, report, portal, import, or financial rule is listed above as absent.
