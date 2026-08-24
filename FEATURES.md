# Logistics Operations Control Tower — Feature Specification

## 1. Purpose

This document converts the supplied Juri Gari forms, dashboard prototype, and upload workbook into a build-ready product specification for a configurable B2B logistics operations platform. The product must support Juri Gari's contract-to-placement-to-trip-to-billing-to-settlement workflow while remaining reusable for other transport aggregators, fleet operators, and managed logistics businesses.

The public Juri Gari website describes the business as a freight aggregator connecting customers, fleet owners, transporters, and warehouses, with customer and delivery-partner access. Source: <https://www.jurigari.com/>.

This is a living specification. Update feature status and acceptance results in this file whenever Codex completes a feature.

## 2. Source artifacts and precedence

1. `Jurigari Control Tower Upload Formats.xlsx` — canonical field names, code lists, import rules, and ageing rules.
2. `forms.html` — prototype UX, required fields, defaults, calculated previews, queue, and CSV export.
3. `dashboard.html` — prototype KPIs, drill-down reports, filters, exports, and status calculations.
4. This specification — resolves source conflicts and adds the platform capabilities required by the stated operating model.

When sources conflict:

- Preserve raw events instead of overwriting derived totals.
- Store money in the smallest currency unit or an exact decimal type; never binary floating point.
- Store timestamps in UTC and render them in the tenant/user timezone. Juri Gari defaults to `Asia/Kolkata`.
- A missing receipt means there is no receipt transaction. Invoice-level `paymentReceived` is derived as zero from receipts. This resolves the workbook's blank-versus-zero inconsistency.
- Collection traffic-light ageing is measured from client acknowledgement/submission date and remains separate from contractual due date.
- Traffic-light status is computed and must never be accepted as an uploaded source field.

## 3. Status legend

Implementation status:

| Status         | Meaning                                                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Prototype only | Demonstrated in static/local HTML or sample data, but no production persistence, authorization, API, or automated tests exist. |
| Specified only | Defined in the workbook or this document, but not demonstrated in the HTML.                                                    |
| Proposed       | Required for the target operating model or reusable product; business confirmation is still advisable.                         |
| In progress    | Implementation exists but all acceptance criteria have not passed.                                                             |
| Complete       | Implemented, authorized, persisted, observable, and all listed end-to-end acceptance tests pass.                               |
| Blocked        | A named unresolved decision or external dependency prevents completion.                                                        |

Test status:

| Status      | Meaning                                                                                                                          |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Not started | No approved feature test plan or executable feature tests exist.                                                                 |
| Planned     | Acceptance criteria are mapped to approved test IDs, but executable coverage is incomplete.                                      |
| Implemented | Required tests exist but the full local acceptance suite is not currently passing.                                               |
| Failing     | The required suite ran and has one or more named failures.                                                                       |
| Passing     | Required unit/integration/contract/security/migration and Playwright acceptance tests pass against the locally deployed feature. |
| Blocked     | A named blocker prevents the required test suite from running or passing.                                                        |

## 4. Product-wide rules

### 4.1 Tenant isolation and configuration

- Every business record carries `tenantId`; queries, PostgreSQL-backed jobs/events, documents, notifications, reporting projections, and exports are tenant-scoped.
- Tenant administrators configure branding, locale, timezone, currency, numbering patterns, enabled modules, status thresholds, reason lists, document requirements, notification channels, and approval policies.
- Never hard-code Juri Gari, PHANI, NAND, a client name, a GSTIN, a branch, or a threshold in application logic.

### 4.2 Current infrastructure boundary

- Deploy a Next.js frontend and NestJS backend backed only by PostgreSQL.
- Reuse the workstation's central `shared-postgres` Docker container. Provision project-owned roles, databases, and `app`, `audit`, and `reporting` schemas; never start a project-specific PostgreSQL container.
- Do not add Redis, a message broker, external queue, object-storage container, Mailpit, or a separate worker deployment without an approved superseding ADR and explicit user authorization.
- Persist current-phase events, idempotency keys, job/lease state, audit, reporting projections, and required document bytes in PostgreSQL behind replaceable interfaces.

### 4.3 Roles and scope

Baseline roles are Platform Admin, Tenant Owner, MIS Executive, Regional Manager, Key Account Manager, Traffic/Placement Executive, Finance Executive, Collection Executive, Loading Executive, Unloading Executive, Vendor Owner, Driver, Client Viewer, and Auditor.

Access can be scoped by tenant, legal entity, region, branch, client, location, vendor, or assigned trip. Deny by default. A user may hold multiple roles. Sensitive fields such as PAN, GSTIN, bank details, mobile numbers, commercial rates, and payment data require explicit permission.

### 4.4 Record, event, and audit conventions

- Use stable internal IDs plus tenant-unique human-readable codes.
- Use optimistic concurrency or record versions for edits.
- Maintain immutable audit events with actor, timestamp, source, before/after values, reason, request/correlation ID, and impersonation context.
- Use soft deactivation for referenced masters. Transaction deletion requires elevated permission and a reason; financial postings should be reversed, not deleted.
- All list screens support server-side pagination, sorting, filtering, saved views, and permission-aware export.

### 4.5 Canonical lifecycle

`Contract/rate card → indent → vendor allocation → vehicle/driver placement → trip milestones → delivery → POD → client invoice → receipt/collection → vendor bill → vendor payment → closure`

Exceptions remain visible and actionable: cancellation, NTP, replacement vehicle, loading delay, shortage, damage, missing POD, invoice hold, deduction, short receipt, disputed vendor charge, and failed payment.

### 4.6 Canonical computed rules

- Placement commitment defaults to `indentReceivedAt + applicable placement TAT`; an authorized user may override it with a reason.
- Placement variance hours = `actualPlacementAt or now − committedPlacementAt`.
- Default placement colour: Green `≤ 24` hours after commitment, Yellow `> 24 and ≤ 48`, Red `> 48`. A vehicle still awaited or NTP continues ageing. Cancelled records are excluded from fill-rate denominators unless a tenant policy says otherwise.
- Fill rate = placed eligible indents / eligible indents × 100.
- POD age = `podReceivedAt or now − deliveredAt`. Default POD colour: Green `≤ 7` calendar days, Yellow `> 7 and ≤ 15`, Red `> 15`; an unreceived POD carried from a prior calendar month is also Red.
- Total invoice = taxable value + GST + configured charges − configured credits.
- Contractual due date = acknowledged submission date + client credit days.
- Invoice balance = total invoice − posted receipts − accepted credit notes/deductions, floored at zero unless overpayment credits are supported.
- Default collection colour for an open invoice: Green `≤ 30` days from acknowledgement, Yellow `31–45`, Red `> 45`; a settled invoice is Green/Closed.
- Financial totals are computed from transaction lines. Manual summary overrides are prohibited.

## 5. Feature register

| ID | Feature | Evidence | Implementation status | Test status | Depends on |
|---|---|---|---|---|---|
| FND-01 | Multi-tenant product foundation | Product objective | Complete | Passing | — |
| FND-02 | Identity, roles, and scoped access | Operating-model roles | In progress | Implemented | FND-01 |
| MST-01 | Organization, employee, and geography masters | Workbook managers; stated hierarchy | In progress | Implemented | FND-01, FND-02 |
| MST-02 | Client, contract, lane, SLA, and rate-card masters | Client/location forms; contract business model | In progress | Implemented | MST-01 |
| MST-03 | Vendor, vehicle, driver, and compliance masters | Vendor form; vendor/driver actors | In progress | Implemented | MST-01 |
| OPS-01 | Indent capture and lifecycle | Indent form/workbook | In progress | Implemented | MST-02 |
| OPS-02 | Vendor allocation and placement | Placement form/dashboard | In progress | Implemented | OPS-01, MST-03 |
| OPS-03 | Trip execution, loading, transit, and unloading | Stated actors; dashboard mentions GPS | In progress | Implemented | OPS-02 |
| DOC-01 | POD and delivery-document workflow | POD form/dashboard | In progress | Implemented | OPS-03 |
| FIN-01 | Client billing and invoice workflow | Invoice form/workbook | In progress | Implemented | DOC-01, MST-02 |
| FIN-02 | Receipts, reconciliation, and collections | Receipt/invoice forms/dashboard | In progress | Implemented | FIN-01 |
| FIN-03 | Vendor bills, deductions, and payments | Stated vendor-payment need | In progress | Implemented | OPS-03, MST-03 |
| CTL-01 | Control tower dashboards and drill-down reports | Dashboard prototype | In progress | Implemented | Transaction modules |
| ALT-01 | Alerts, escalation, and work queues | Traffic lights and operating need | In progress | Implemented | Transaction modules, FND-02 |
| DAT-01 | Bulk import, validation, correction, and export | Workbook/read-me/forms queue | In progress | Implemented | Masters and transactions |
| GOV-01 | Documents, comments, audit, and approvals | Audit trail notes and regulated data | In progress | Implemented | FND-02 |
| INT-01 | APIs, notifications, GPS, accounting, and migration connectors | Current WhatsApp/Excel; GPS note | In progress | Implemented | FND-01, GOV-01 |
| CFG-01 | No-code tenant configuration and white-labeling | Resale objective | In progress | Implemented | FND-01 |

## 6. Common Codex build contract

Every feature prompt below includes this contract by reference. Codex must:

1. Inspect the repository, its architecture, existing conventions, and `AGENTS.md` before changing code. Do not invent a second stack.
2. Restate the feature boundary, dependencies, assumptions, and files likely to change. Ask only about a decision that cannot be safely made or configured.
3. Implement the smallest complete vertical slice: migration/schema, domain rules, service/API, authorization, UI, validation, audit/telemetry, seed/fixture updates, and tests.
4. Enforce tenant scope and permissions on the server. UI hiding is not authorization.
5. Use accessible responsive UI, keyboard operation, labelled inputs, clear empty/loading/error states, and safe confirmations.
6. Make calculations deterministic and unit-tested at exact boundaries. Use tenant timezone where calendar boundaries matter.
7. Add idempotency for retried writes, imports, webhooks, financial posting, and notifications where applicable.
8. Preserve unrelated user changes. Avoid destructive migration behavior. Include rollback-safe migrations.
9. Run focused tests plus the relevant full suite, typecheck, lint, and production build. Fix failures caused by the change.
10. As the final pre-commit gate, synchronize implementation status and test status in the feature register and feature section, `README.md`, `TODO.md`, `specs/<FEATURE-ID>/spec.md`, `test-plan.md`, `completion.md`, executable test/TODO files, and any affected documentation. Remove completed TODOs, record remaining TODOs with owners/reasons, and ensure every test ID has its final status/evidence. Only then report changed files, commands, test results, decisions, and remaining risks. Do not provide schedule estimates.

---

## FND-01 — Multi-tenant product foundation

**Status:** Complete

**Test status:** Passing

**Outcome:** One deployable product can safely serve multiple logistics companies, each with isolated data, branding, configuration, and legal entities.

### UX flow and details

1. Platform Admin creates a tenant from a protected admin console.
2. Enter tenant name, code, legal name, GSTIN/tax identifier, registered address, timezone, locale, currency, fiscal-year start, default legal entity, support contact, and active state.
3. The system creates an owner invitation, default roles, default reason lists, default thresholds, and tenant-scoped PostgreSQL records.
4. Tenant Owner completes a setup checklist: organization, users, branches, clients, vendors, commercial settings, imports, and branding.
5. Tenant switcher appears only for users explicitly assigned to more than one tenant; switching clears tenant-specific frontend/session state.

### Reports and alerts

- Platform report: active tenants, user counts, PostgreSQL storage, integration health, backend job/event failures, and last activity; no cross-tenant business data by default.
- Alert Platform Admin on provisioning failure, tenant-scope invariant failure, storage boundary failure, or repeated job failure.

### Acceptance criteria and end-to-end tests

- Creating Tenant A provisions defaults and sends exactly one expiring owner invitation.
- A Tenant A user cannot retrieve, search, mutate, export, guess an ID for, or receive an alert about Tenant B data through UI, API, websocket, PostgreSQL-backed job/event, document endpoint, reporting projection, or bulk export.
- A multi-tenant user switches from A to B and sees only B branding, settings, counts, and recent records.
- Tenant deactivation blocks login and jobs without deleting records; reactivation restores access.
- Automated isolation tests run for every tenant-owned table/resource.

### Master prompt for Codex

> Implement **FND-01 Multi-tenant product foundation** from `FEATURES.md`, following the Common Codex build contract. Bootstrap the Next.js frontend and NestJS backend against the central shared PostgreSQL container; build tenant schema/request context, secure provisioning, owner invitation, tenant switcher, tenant-scoped PostgreSQL persistence/documents/events/reporting, setup checklist, platform health view, and automated cross-tenant isolation tests. Do not add Redis, object storage, a message broker, Mailpit, or a separate worker. Seed configurable defaults rather than Juri Gari constants. Do not implement business transaction modules except the minimum tenant-owned example needed to prove isolation. Complete the final cross-file implementation/test status synchronization only when all listed end-to-end tests pass.

---

## FND-02 — Identity, roles, and scoped access

**Status:** In progress

**Test status:** Implemented

**Outcome:** Every person sees and changes only the data and actions required for their role and operational scope.

### UX flow and fields

1. Tenant Owner invites a user by name, employee code, email and/or mobile, authentication method, roles, and scope assignments.
2. Scope fields: legal entities, regions, branches, clients, locations, vendors, and whether access is read, create, update, approve, export, or administer.
3. User accepts invitation, verifies identity, sets up MFA if policy requires it, and lands on a role-appropriate home/work queue.
4. Admin can suspend access, reset sessions, change scope, and review effective permissions before saving.
5. Vendor, driver, and client users use limited portals with no access to internal margins, unrelated parties, or unrestricted exports.

### Reports and alerts

- Reports: user directory, role assignments, dormant accounts, failed logins, active sessions, privileged actions, and permission changes.
- Alerts: repeated failed logins, MFA disabled, privileged role granted, access outside expected geography, suspended user session attempt.

### Acceptance criteria and end-to-end tests

- A Regional Manager sees only assigned regions; a KAM sees only assigned clients; a Vendor sees only its allocations/trips/payments; a Driver sees only assigned trip actions.
- Direct API calls outside scope return a non-leaking denial and create a security audit event.
- Removing scope invalidates active sessions or permission caches immediately.
- Effective-permission preview matches server authorization for representative create/read/update/export/approve operations.
- Sensitive fields are masked unless the permission explicitly allows them.

### Master prompt for Codex

> Implement **FND-02 Identity, roles, and scoped access** from `FEATURES.md` and the Common Codex build contract. Add invitations, authentication/session integration, MFA policy hooks, multi-role assignment, hierarchical scope grants, effective-permission evaluation, server-side authorization middleware/policies, limited vendor/driver/client portal shells, sensitive-field masking, access review UI, and security audit tests. Prove denial for ID guessing and direct API calls. Do not hard-code role checks into UI components; centralize capabilities and scope evaluation.

---

## MST-01 — Organization, employee, and geography masters

**Status:** In progress

**Test status:** Implemented

**Outcome:** Configurable organization structure drives ownership, routing, permissions, filters, and escalations.

### UX flow and form fields

1. Admin creates legal entities, then regions, branches, and teams in a hierarchy view.
2. Employee form: employee code, name, designation, email, mobile, manager, home branch, regions, active dates, linked user account, and roles.
3. Geography form: country, state, district, city, postal code, latitude, longitude, and geofence radius.
4. Bulk assignment lets an admin map KAMs to clients, branch managers to locations, and traffic executives to operating queues.
5. Deactivation preview lists impacted users, clients, locations, open records, and escalation routes before confirmation.

### Reports and alerts

- Organization tree; clients/locations/vendors per manager; unowned active records; inactive employee with open assignments.
- Alert admins when an open workflow has no active owner or escalation path.

### Acceptance criteria and end-to-end tests

- Hierarchy filters cascade consistently through list screens, dashboards, exports, and alert recipients.
- Deactivating a manager does not orphan records silently; reassignment is required or an exception is recorded.
- Cyclic manager or organization relationships are rejected.
- An employee's effective scope updates after reassignment and is audit logged.

### Master prompt for Codex

> Implement **MST-01 Organization, employee, and geography masters** from `FEATURES.md` using the Common Codex build contract. Build hierarchical legal entity/region/branch/team models, employee profiles, geography/geofence data, assignment UI, deactivation impact checks, ownership reports, and orphan-owner alerts. Integrate hierarchy scopes with FND-02 and test cascading authorization and cycle prevention.

---

## MST-02 — Client, contract, lane, SLA, and rate-card masters

**Status:** In progress

**Test status:** Implemented

**Outcome:** Commercial and service commitments are versioned once and applied consistently to indents, billing, reporting, and alerts.

### UX flow and form fields

1. Create Client: client code (tenant-unique uppercase/no spaces), client name, industry, billing entity, GSTIN, account manager, escalation name/email/mobile, credit days, POD submission mode, active state.
2. Create Location under a client: location code (`CLIENT-LOC` convention), name, address/geography, state, type (`Plant`, `Depot`, `DC`, `Warehouse`, `CFA`, `Market`), branch manager, traffic manager/mobile, geofence, active state.
3. Create Contract: contract number, client/legal entity, validity dates, billing cycle, tax behavior, credit terms, document requirements, approval status, attachment, and version.
4. Create Lane/SLA: origin, destination, client/location, truck/body type, cargo type, quantity/weight limits, placement TAT hours, transit TAT, loading/unloading free time, POD TAT, service window, and exception rules.
5. Create effective-dated client rate card: lane/SLA, vehicle type, base freight, per-km/per-MT/fixed basis, minimum charge, detention, loading/unloading, toll, fuel surcharge, additional charges, GST treatment, and approval.
6. Publish an approved version. Existing transactions retain their rate/SLA snapshot; new transactions use the version effective at indent time.

### Validation and rules

- Client/location codes are immutable after use or changed through a governed alias/migration.
- GSTIN, email, mobile, date range, and rate overlap validation are tenant/locale aware.
- Different TATs by truck type are represented as lane/SLA rules, not fake duplicate locations.
- Inactive or draft records cannot be selected for new transactions.

### Reports and alerts

- Client/location directory; expiring contracts; unpublished/draft rates; overlapping or missing lane rates; SLA coverage; commercial change history.
- Alerts before contract/rate expiry and when an indent has no matching published SLA/rate.

### Acceptance criteria and end-to-end tests

- A valid client/location/contract/lane/rate can be created, approved, published, selected, and later versioned.
- An indent snapshots the correct effective rate, credit terms, document rules, and TAT; later master changes do not alter that snapshot.
- Overlapping active rate versions for the same matching dimensions are rejected or resolved by an explicit priority rule.
- Deactivated clients/locations disappear from new-entry selectors but remain readable on historical records.
- Exact workbook client and location columns can import into these masters without losing data.

### Master prompt for Codex

> Implement **MST-02 Client, contract, lane, SLA, and rate-card masters** from `FEATURES.md` using the Common Codex build contract. Preserve every Client Master and Location Master workbook field, then add effective-dated contracts, lanes, SLA rules, client rate cards, approval/publish/version workflows, immutable transaction snapshots, overlap detection, deactivation behavior, expiry/missing-rate alerts, reports, and import compatibility. Use configuration for code patterns, location types, tax rules, and charges.

---

## MST-03 — Vendor, vehicle, driver, and compliance masters

**Status:** In progress

**Test status:** Implemented

**Outcome:** Operations can allocate only eligible supply, while finance can settle verified vendors securely.

### UX flow and form fields

1. Vendor onboarding: vendor code, business/name, owner, base location, contacts, PAN, GSTIN, fleet size, served truck types, onboarded-by employee code/name, onboarding date, active state.
2. Add commercial and payment data: vendor type, service regions/lanes, bank account holder/number/IFSC, payment terms, TDS category/rate, MSME details, approved status. Bank changes require re-verification and dual control.
3. Vehicle form: registration number, ownership, truck/body type, capacity, make/model/year, GPS device, permit, fitness, insurance, pollution certificate, tax validity, and active/blocked state.
4. Driver form: name, mobile, alternate contact, licence number/class/validity, address, emergency contact, KYC, vendor, allowed vehicles, safety status, and portal identity.
5. Upload compliance documents with issue/expiry dates and verification status. An eligibility engine returns eligible, warning, or blocked with reasons.

### Reports and alerts

- Vendor/fleet directory; eligible capacity by location/type; expiring/expired compliance; blocked vehicles/drivers; onboarding credit; bank-detail change log.
- Alerts to vendor and responsible manager before document expiry; block allocation after configured grace policy.

### Acceptance criteria and end-to-end tests

- All Vendor Master workbook columns round-trip through create/edit/import/export.
- Duplicate PAN/GSTIN/registration/licence rules identify likely duplicates without leaking across tenants.
- An expired mandatory document prevents allocation and states the exact reason; authorized override requires reason and audit.
- Bank detail changes are masked, re-verified, approved by a different permitted user, and fully audited.
- Vendor portal exposes only its own masters and actionable compliance issues.

### Master prompt for Codex

> Implement **MST-03 Vendor, vehicle, driver, and compliance masters** from `FEATURES.md` and the Common Codex build contract. Preserve the Vendor Master workbook fields, add secure bank/TDS/MSME data, vehicle and driver registries, document metadata/storage, eligibility evaluation, maker-checker verification, compliance reports/alerts, duplicate detection, masking, and vendor self-service. Integrate eligibility with allocation without implementing the full allocation workflow.

---

## OPS-01 — Indent capture and lifecycle

**Status:** In progress

**Test status:** Implemented

**Outcome:** Every customer truck requirement becomes a traceable, assigned, SLA-bound indent rather than a WhatsApp message.

### UX flow and form fields

1. MIS/KAM creates an indent manually, copies a similar indent, imports it, or receives it by API.
2. Fields: Indent No, Indent Date & Time, Client Code, Location Code, Origin, Destination, Truck Type, Qty/Weight (MT), cargo/body type, requested vehicles, pickup window, contact, special instructions, contract/lane, source/reference, attachments.
3. System selects the applicable SLA and computes Committed Placement Date & Time. Override requires permission, new time, reason, and optionally approval.
4. Validate/save draft, then submit. Status lifecycle: Draft, Open, Partially Allocated, Fulfilled, Cancelled, Closed. Placement execution state remains separate.
5. User can edit permitted fields with version conflict handling; commercial/SLA snapshots are preserved.
6. Cancellation captures cancelled quantity, actor, timestamp, reason, client confirmation, and whether vendor costs apply.

### Reports and alerts

- Indent register; demand by client/location/lane/truck type; open and unassigned indents; cancellations; SLA overrides; source completeness.
- Alert assigned placement team on a new submitted indent, missing master/rate, approaching commitment, or unowned indent.

### Acceptance criteria and end-to-end tests

- All workbook Indent fields are supported, including Origin, Destination, status, delay reason, and remarks.
- Location selection is filtered by client; commitment defaults from the effective SLA/location TAT and can be overridden only with a recorded reason.
- Duplicate tenant indent numbers are rejected across manual, import, and API paths; idempotent retries return the original result.
- Cancelling an indent updates eligible demand/fill denominators according to policy without deleting history.
- Concurrent edits do not silently overwrite one another.

### Master prompt for Codex

> Implement **OPS-01 Indent capture and lifecycle** from `FEATURES.md` and the Common Codex build contract. Build manual/copy/import/API-ready indent creation, exact workbook field compatibility, client-filtered locations, SLA/rate snapshot selection, computed commitment with governed override, lifecycle and cancellation, optimistic concurrency, ownership, reports, alerts/events, and boundary/idempotency/end-to-end tests. Keep vendor allocation and placement as integration seams for OPS-02.

---

## OPS-02 — Vendor allocation and placement

**Status:** In progress

**Test status:** Implemented

**Outcome:** Placement teams allocate demand to eligible vendors, capture vehicle/driver reporting, measure fill and delay, and escalate NTP consistently.

### UX flow and form fields

1. Open placement work queue ordered by commitment risk. Filters: region, branch, manager, client, location, lane, truck type, status, colour, vendor, and free-text search.
2. Allocate all or part of requested quantity to one or more vendors. Allocation fields: vendor, allotted quantity, offered rate/cost snapshot, offer channel, offer/response timestamps, acceptance status, rejection reason, owner, and notes.
3. Vendor accepts/rejects in portal or verified response channel. Rejection/expiry returns quantity to the queue.
4. Assign an eligible vehicle and driver. Allow controlled replacement with reason and complete history.
5. Confirm actual placement with vehicle number, driver name/mobile, actual reporting time, status (`Placed`, `Awaited`, `NTP`, `Cancelled`), NTP/delay reason, remarks, and optional gate/geofence evidence.
6. System stops placement clock on actual placement; Awaited and NTP continue ageing. Show a live preview of variance and colour.

### Reports and alerts

- Indent MIS; client/location fill; pending placement; breach list; vendor allocation cards with allotted/placed/NTP; acceptance rate; response time; replacement history; delay reason Pareto.
- Alerts at configurable pre-breach and breach thresholds, vendor offer expiry, vendor rejection, ineligible assignment attempt, vehicle replacement, and unresolved NTP.

### Acceptance criteria and end-to-end tests

- A placed allocation requires vehicle and actual placement timestamp; invalid state combinations are rejected server-side.
- Vendor/vehicle/driver selectors include only active, eligible, scope-valid records and explain exclusions.
- Boundary tests return Green at exactly 24 hours after commitment, Yellow immediately above 24 through 48, and Red immediately above 48.
- Partial allocation produces correct remaining quantity, placed count, pending count, and fill rate without double counting.
- Replacement preserves the former assignment and recalculates reports without rewriting history.
- The three-level placement dashboard reconciles exactly to transaction rows.

### Master prompt for Codex

> Implement **OPS-02 Vendor allocation and placement** from `FEATURES.md` using the Common Codex build contract. Add risk-ordered work queues, split allocations, vendor offer/response workflow, eligible vehicle/driver assignment, replacement history, placement confirmation, exact status/reason lists, live ageing preview, configurable traffic-light engine, fill calculations, vendor-allocation and delay reports, alerts, and reconciliation tests. Preserve workbook export compatibility while modeling multiple allocations correctly.

---

## OPS-03 — Trip execution, loading, transit, and unloading

**Status:** In progress

**Test status:** Implemented

**Outcome:** Field events replace WhatsApp updates and create an auditable trip record from gate-in through delivery.

### UX flow and form fields

1. Placement creates a trip or shipment record with LR generation option, assigned vehicle/driver, lane, cargo, and planned milestones.
2. Loading Executive uses a mobile-first screen: arrival/gate-in, loading start/end, loaded quantity/weight, packages, LR/challan/e-way bill references, seal number, photos, shortage/damage, detention reason, and departure.
3. Driver sees trip brief, contact and navigation actions, document checklist, start-trip action, location permission, checkpoint/exception buttons, and SOS/contact support.
4. Transit events arrive from GPS or manual verified updates: coordinates, speed, timestamp, source, odometer, stoppage, route deviation, ETA, and exception notes.
5. Unloading Executive captures destination arrival, unloading start/end, delivered quantity, receiver, OTP/signature/stamp, shortage/damage, photos, and delivery completion.
6. Offline entries queue locally with original event time and sync status; server resolves duplicates idempotently and flags conflicts.

### Reports and alerts

- Live trip map/list; milestone status; ETA; route/stoppage exceptions; loading/unloading turnaround; detention; transit TAT; on-time delivery; field data completeness.
- Alerts for missed milestones, late gate-in/departure/delivery, long stoppage, route deviation, GPS silence, document gap, shortage/damage, and offline sync failure.

### Acceptance criteria and end-to-end tests

- A field user can complete assigned actions on a small screen with intermittent connectivity and no access to unrelated trips.
- Duplicate offline/API/GPS events do not create duplicate milestones.
- Event ordering conflicts are retained and flagged; audit retains device time, received time, source, actor, and location.
- Delivery completion supplies the POD workflow with consistent delivered time and receiver evidence.
- Unauthorized location tracking outside an active assigned trip is not collected.

### Master prompt for Codex

> Implement **OPS-03 Trip execution, loading, transit, and unloading** from `FEATURES.md` with the Common Codex build contract. Build trip/milestone/event models, mobile role-specific flows, offline queue and idempotent sync, loading/unloading forms, GPS/manual event ingestion seams, ETA/exception calculation, evidence uploads, live-trip reports, alerts, privacy controls, and end-to-end offline/conflict/security tests. Emit a delivery-completed event consumed by DOC-01.

---

## DOC-01 — POD and delivery-document workflow

**Status:** In progress

**Test status:** Implemented

**Outcome:** Each LR has traceable delivery proof, discrepancy evidence, submission acknowledgement, and POD ageing.

### UX flow and form fields

1. Delivery completion opens a POD task. Manual entry/import remains available for historical data.
2. Fields: LR No, Indent No, Client Code, Location Code, Invoice No(s), Invoice Date, Vehicle No, Truck Type, Loading Date, Delivery Date, POD Received Date, POD Submitted to Client Date, POD Mode, Receiver Name, Stamp Present, Shortage/Damage Remarks.
3. Upload POD images/PDF, receiver signature/OTP evidence, and discrepancy documents. Run file validation and optional OCR; user confirms extracted values.
4. Workflow: Awaiting POD → Received/Under Review → Accepted → Submitted to Client → Closed, with Rejected/Correction Required exception paths.
5. A received date stops ageing. Submission captures channel, acknowledgement/reference, actor, and timestamp.
6. Support one LR linked to multiple invoices and the workbook's duplicate-row representation during import/export without double-counting POD closure.

### Reports and alerts

- POD register; current-period pending; prior-period pending; value at risk; closure rate; ageing; rejected/correction queue; POD by vendor/driver/client/location.
- Alerts at configurable POD thresholds, missing mandatory stamp/signature, rejected POD, prior-period carryover, and received-but-not-submitted POD.

### Acceptance criteria and end-to-end tests

- Boundary tests produce Green through 7 days, Yellow above 7 through 15, and Red above 15; unreceived prior-calendar-period records follow configured carryover policy.
- Received POD stops ageing at receipt date; correcting receipt date recalculates with audit.
- Value at risk uses linked invoice value without double counting invoices linked to multiple POD rows.
- Files are malware/type/size checked, stored in PostgreSQL for the current infrastructure phase, permission protected, and accessible through expiring authorized backend URLs.
- POD submission requirements derive from the contract snapshot.

### Master prompt for Codex

> Implement **DOC-01 POD and delivery-document workflow** from `FEATURES.md` under the Common Codex build contract. Preserve all workbook fields; add PostgreSQL-backed document storage behind an abstraction, an OCR-confirmation seam without adding new local infrastructure, status/review/correction/submission workflow, multi-invoice/LR relations, contract document requirements, exact ageing/carryover calculations, value-at-risk deduplication, reports, alerts, secure backend file access, and end-to-end boundary/security/reconciliation tests.

---

## FIN-01 — Client billing and invoice workflow

**Status:** In progress

**Test status:** Implemented

**Outcome:** Completed eligible services become accurate, approved, submitted client invoices with traceable commercial calculations.

### UX flow and form fields

1. Finance opens Unbilled Services grouped by client, location, billing cycle, and contract. Eligibility checks delivery/POD/document requirements and unresolved exceptions.
2. Select trips/LRs, preview charges from the client rate snapshot, add authorized charge/credit lines, and view margin preview if permitted.
3. Draft invoice fields: Invoice No, Invoice Date, Client, Location, Billing Month, taxable line values, GST/tax lines, Total Invoice Amount, Credit Days, Due Date, attachments, linked trips/LRs, and notes.
4. Submit for maker-checker approval. Approved invoice is posted; numbering becomes immutable.
5. Record Submission Date to Client only from acknowledgement, plus mode, reference, attachment, and submitter. This date starts collection ageing and contractual due-date calculation.
6. Support rejection, correction before posting, credit/debit note, cancellation/reversal, and accounting export with audit.

### Reports and alerts

- Unbilled service, billing register, draft/approval queue, billed revenue, tax summary, unsubmitted invoices, missing acknowledgements, billing leakage, rate variance, and client/location profitability where permitted.
- Alerts for unbilled eligible service, invoice approval rejection, missing POD/document, posted-but-unsubmitted invoice, and accounting export failure.

### Acceptance criteria and end-to-end tests

- Total invoice uses exact decimal arithmetic and reconciles to line taxable values and taxes.
- Due date is computed from acknowledged submission date plus snapshotted credit days, not invoice date.
- The same billable trip/charge cannot be invoiced twice except through explicit adjustment workflow.
- Posting locks numbering and commercial lines; changes use controlled reversal/note paths.
- Import of workbook invoices either reconciles to receipt lines or creates auditable opening transactions without inventing receipts.

### Master prompt for Codex

> Implement **FIN-01 Client billing and invoice workflow** from `FEATURES.md` and the Common Codex build contract. Build unbilled-service eligibility, rate-snapshot charge calculation, exact tax/total arithmetic, grouped draft generation, maker-checker approval, immutable posting/numbering, acknowledgement-based submission, due-date calculation, credit/debit/reversal seams, reports, alerts, accounting-export events, workbook compatibility, and duplicate-billing/reconciliation tests.

---

## FIN-02 — Receipts, reconciliation, and collections

**Status:** In progress

**Test status:** Implemented

**Outcome:** Each bank credit is allocated transparently, invoice balances are derived, deductions remain visible, and collection owners work prioritized queues.

### UX flow and form fields

1. Create/import bank receipt: Receipt Ref, Client, Payment Date, Amount Received, Mode (`NEFT`, `RTGS`, `IMPS`, `Cheque`, `UPI`, `Adjustment`), UTR/Instrument No, bank account, source, and attachment.
2. Allocate one receipt across one or more invoices; also support multiple receipts per invoice. Show remaining unallocated amount and invoice balance.
3. Allocation fields: invoice, allocated amount, deduction amount, deduction reason, credit note/reference, notes, and reconciliation state.
4. Reconcile with maker-checker where configured. Reversal creates compensating entries.
5. Collection work queue prioritizes open invoices by colour, value, due status, owner, hold reason, and last follow-up.
6. Follow-up captures date/time, channel, contacted person, outcome, promise-to-pay date/amount, next action, hold/deduction reason, SOA reference, notes, and attachments.

### Reports and alerts

- Collection client/location boards; invoice register; total billed/received/due; part paid; unallocated receipts; unapplied deductions; ageing buckets `0–30`, `31–45`, `46–90`, `>90`; promise-to-pay; follow-up productivity; SOA.
- Alerts for open invoice thresholds, broken promise-to-pay, no follow-up, unallocated receipt, duplicate UTR, deduction requiring action, and reconciliation failure.

### Acceptance criteria and end-to-end tests

- Invoice received and balance values equal posted allocation transactions; editing a summary amount directly is impossible.
- A part payment leaves the balance open; full payment closes it; over-allocation is blocked or creates an explicit on-account credit according to policy.
- Duplicate receipt/UTR detection and idempotent imports prevent double posting.
- Collection boundary tests classify open balances Green through 30 days, Yellow 31–45, Red above 45; closed balances are Closed/Green.
- Dashboard, invoice register, receipt register, and SOA reconcile to the same ledger totals.
- Reversal restores balances and retains original and reversing audit entries.

### Master prompt for Codex

> Implement **FIN-02 Receipts, reconciliation, and collections** from `FEATURES.md` following the Common Codex build contract. Use an append-only receipt/allocation/reversal ledger, exact workbook receipt fields and code lists, many-to-many allocation, deductions/on-account policy, maker-checker reconciliation, prioritized collection queues and follow-ups, ageing/SOA reports, alerts, duplicate/idempotency controls, and end-to-end ledger/dashboard reconciliation tests. Do not store editable cumulative payment totals.

---

## FIN-03 — Vendor bills, deductions, and payments

**Status:** In progress

**Test status:** Implemented

**Outcome:** Vendor obligations are calculated from performed services, approved against evidence, and paid with full reconciliation and margin visibility.

### UX flow and form fields

1. Completed eligible trips appear in Unbilled Vendor Services with snapshotted vendor rate/cost and exceptions.
2. Vendor submits a bill through portal/import or finance creates one. Fields: vendor invoice/reference, vendor, invoice date, service period, linked trips/LRs, taxable lines, GST, TDS, advances, deductions, payable total, attachment.
3. Three-way validation compares allocation/trip, agreed vendor cost, and bill/document. Variances require reason and approval.
4. Approval workflow supports maker, operational verifier, finance approver, rejection, correction, and dispute.
5. Payment run selects approved due bills, validates bank verification, creates payment batch, records UTR/status, and allocates partial/full payments.
6. Generate remittance advice and vendor ledger; failed/reversed payments reopen the payable through compensating entries.

### Reports and alerts

- Unbilled vendor service; payable ageing; approved/unapproved bills; vendor ledger; deductions/disputes; payment run; TDS/GST summary; trip/client contribution margin.
- Alerts for missing vendor bill, rate variance, compliance/payment block, approval pending, due/overdue payable, bank change, failed payment, and unresolved dispute.

### Acceptance criteria and end-to-end tests

- Every payable line traces to a trip or approved standalone adjustment and the effective vendor rate snapshot.
- Duplicate vendor invoice numbers and duplicate trip billing are prevented within configured scope.
- TDS, GST, deductions, advances, payments, and outstanding balance reconcile exactly.
- A maker cannot approve their own bill/payment when segregation policy is enabled.
- Payment uses only a verified approved bank account; a bank change blocks payment until reapproved.
- Client revenue minus vendor cost and approved trip charges produces reproducible contribution margin.

### Master prompt for Codex

> Implement **FIN-03 Vendor bills, deductions, and payments** from `FEATURES.md` using the Common Codex build contract. Build trip-backed payable eligibility, vendor bill portal/import, exact decimal tax/TDS/deduction/advance calculations, three-way validation, configurable maker-checker approval, append-only payment allocations/reversals, verified-bank enforcement, remittance advice, vendor ledger, payable/margin reports, alerts, and duplicate/segregation/reconciliation tests.

---

## CTL-01 — Control tower dashboards and drill-down reports

**Status:** In progress

**Test status:** Implemented

**Outcome:** Owners and managers move from portfolio risk to the exact actionable record without separate Excel preparation.

### UX flow and report details

1. Role-scoped landing page opens with Placement, POD vs Invoice, Collection, Trip, and Vendor Payable tabs enabled by tenant/module access.
2. Global controls: as-of timestamp, live/paused refresh, tenant timezone, search, hierarchy/client/location/vendor filters, traffic-light filter, saved view, and Download View.
3. Placement KPIs: live indents, Green/Yellow/Red, vehicles placed, awaiting placement, fill rate. Drill path: all clients → client locations → indent MIS. Location columns: indents, placed, pending, G/Y/R, fill. Detail columns preserve prototype fields. Include vendor allotted/placed/NTP block.
4. POD KPIs: invoices/LRs, POD received, pending current period, pending prior periods, value at risk, closure rate. Drill path: clients → locations → LR/POD register.
5. Collection KPIs: invoices submitted, billed, received, outstanding, open invoices, over-45 value/count, oldest, part-paid. Include ageing-bucket view and drill to invoice register with hold/follow-up.
6. Trip dashboard: active, at-risk, delayed, GPS silent, loading/unloading detention, delivery exceptions.
7. Vendor payable dashboard: unbilled, approval pending, due, overdue, payment blocked, disputed, and paid.
8. Any number opens a filtered record list; breadcrumbs preserve filters. Export uses the exact visible scope and records an audit event.

### Alerts and data behavior

- Dashboard shows freshness per source and clearly distinguishes live, delayed, partial, and failed data.
- Server computes metrics from canonical records or verified aggregates; never from browser simulation.
- Empty denominators show `0` or `—` according to metric semantics, never `NaN` or division errors.

### Acceptance criteria and end-to-end tests

- Each KPI reconciles to its drill-down rows and to an independent database query fixture.
- Worst-status aggregation is Red if any scoped child is Red, otherwise Yellow if any is Yellow, otherwise Green; excluded/cancelled behavior follows policy.
- Search/filter/saved-view/breadcrumb/export behavior is consistent at all three levels and permission scoped.
- As-of/freshness state is visible and live refresh does not discard the user's filters or current drill level.
- Responsive and keyboard tests cover cards, tables, tabs, filters, and drill navigation.

### Master prompt for Codex

> Implement **CTL-01 Control tower dashboards and drill-down reports** from `FEATURES.md` and the Common Codex build contract. Replace simulated prototype data with permission-scoped APIs/queries; reproduce Placement, POD, and Collection KPI/drill paths and add Trip and Vendor Payable lenses when their modules exist. Add freshness/as-of state, filters/search/saved views/breadcrumbs/live pause, exact visible export, empty/error/loading states, accessible responsive tables/cards, reconciliation tests, and performance-safe aggregation.

---

## ALT-01 — Alerts, escalation, and work queues

**Status:** In progress

**Test status:** Implemented

**Outcome:** Computed risk becomes assigned, deduplicated action with escalation rather than passive dashboard colour.

### UX flow and configuration fields

1. Tenant Admin configures rules by event/metric, scope, threshold, severity, recipient role/owner, channels, quiet hours, repeat policy, escalation levels, acknowledgement requirement, and resolution condition.
2. Users see a unified work queue with severity, record, client/location, owner, age, due/threshold, last action, and next action.
3. Open an alert to view the calculation/evidence and source record. Actions: acknowledge, assign, comment, snooze where permitted, resolve with outcome, or navigate to fix.
4. The engine automatically resolves state-based alerts when the underlying condition is fixed and links repeat breaches to history.

### Baseline alert catalogue

- New/unowned indent; placement pre-breach, Yellow, Red, unresolved NTP.
- Loading/unloading delay, route deviation, long stoppage, GPS silence, late delivery, shortage/damage.
- POD Yellow, Red, prior-period pending, rejected, or received-not-submitted.
- Invoice unbilled, approval rejected, acknowledgement missing, Collection Yellow/Red, no follow-up, broken promise, deduction/hold.
- Vendor bill missing, payable approval/due/overdue, payment blocked/failed.
- Contract/rate/compliance expiry, import failure, integration/job failure, and privileged security event.

### Reports

- Open alerts by severity/owner/client/region/type; acknowledgement and resolution performance; repeat breaches; escalations; false-positive/override log; alert delivery failures.

### Acceptance criteria and end-to-end tests

- Crossing a threshold creates one open alert, not one per scheduler run; severity escalation updates/link the alert according to rule.
- Exactly-at-boundary calculations match feature rules and tenant timezone.
- Recipients are derived from current record ownership and escalation hierarchy and never escape tenant/scope.
- Acknowledgement does not resolve the business condition; fixing the source condition resolves it automatically where configured.
- Channel retries are idempotent, persisted/leased in PostgreSQL, and delivery status is observable.

### Master prompt for Codex

> Implement **ALT-01 Alerts, escalation, and work queues** from `FEATURES.md` using the Common Codex build contract. Build configurable rule definitions, idempotent evaluation/deduplication, ownership/escalation routing, unified queue/detail/actions, state-based auto-resolution, a PostgreSQL-backed delivery outbox/lease mechanism inside the backend deployment, quiet-hour/repeat policy, baseline catalog adapters for available modules, alert analytics, and exact boundary/security/retry end-to-end tests. Do not add a queue/broker container.

---

## DAT-01 — Bulk import, validation, correction, and export

**Status:** In progress

**Test status:** Implemented

**Outcome:** Existing Excel-based operations migrate safely while users receive row-level feedback and retained history.

### UX flow and fields

1. Choose dataset: Client, Location, Vendor, Indent/Placement, POD, Invoice/Collection opening data, or Payment Receipt.
2. Download a tenant-configured template. Upload `.xlsx` or `.csv`; show filename, size, checksum, uploader, source timezone, and import mode.
3. Map by exact header text by default, not column position. Preview recognized/missing/unknown/duplicate headers and sample normalized values.
4. Validate the complete file before commit: required fields, data types, exact code lists, formats, cross-file references, uniqueness, dates, amounts, state combinations, and permissions.
5. Show row/column errors with downloadable error file. User corrects and retries or excludes allowed warnings.
6. Commit as an idempotent PostgreSQL-backed backend job. For legacy workbook mode, treat each upload as a full current file: upsert by natural key, preserve history, and correct re-sent rows without deleting historical events. Explicitly report records created, updated, unchanged, deactivated/missing, rejected, and warned.
7. Export current view or full permitted dataset with stable headers and formatting.

### Exact workbook compatibility

- Dates: `DD-MM-YYYY`; timestamps: `DD-MM-YYYY HH:MM` 24-hour clock.
- Amounts: rupees, no symbol or embedded comma, two decimals.
- Client/Location codes are joins; accepted code lists match workbook values unless tenant configuration extends them.
- File-name recommendation: `JGL_<Dataset>_YYYYMMDD.xlsx`; do not make the prefix mandatory for non-Juri Gari tenants.
- Status colour columns are rejected/ignored with a clear message because status is computed.

### Reports and alerts

- Import history/detail, row errors, reconciliation, source freshness, uploader, checksum, and rollback/correction relationship.
- Alert dataset owner on failed import, stale required source, partial rejection, reference mismatch, or abnormal record-count change.

### Acceptance criteria and end-to-end tests

- Each of the seven workbook datasets imports a valid representative file and round-trips all fields.
- Header order may change without affecting mapping; misspelled/duplicate mandatory headers fail before commit.
- Unknown codes, missing references, duplicate keys, invalid dates/money, and invalid status combinations return exact row/column errors.
- Retrying the same checksum/idempotency key does not duplicate data or financial postings.
- A corrected full file updates the intended record and retains previous values in audit/history.
- Import authorization and export masking match manual UI/API behavior.

### Master prompt for Codex

> Implement **DAT-01 Bulk import, validation, correction, and export** from `FEATURES.md` with the Common Codex build contract. Use the supplied workbook as executable compatibility fixtures. Build template downloads, header-name mapping, preview, full-file validation, row/column errors, cross-reference and code-list validation, idempotent PostgreSQL-backed backend commit processing, full-file correction semantics with retained history, reconciliation/history UI, freshness alerts, and permission-aware exports. Add fixture-driven end-to-end tests for all seven datasets and every listed failure class without introducing new local infrastructure.

---

## GOV-01 — Documents, comments, audit, and approvals

**Status:** In progress

**Test status:** Implemented

**Outcome:** Operational and financial decisions have secure evidence, discussion, authorization, and an immutable history.

### UX flow and fields

1. Any supported record has tabs for Details, Documents, Comments/Activity, Approvals, and Audit.
2. Document metadata: category, filename, MIME type, size, checksum, version, issue/expiry dates, related record, uploader/source, verification state, confidentiality, and retention class.
3. Comments support mentions, attachments, internal/client/vendor visibility, edit history, and resolution; external users never see internal comments.
4. Configurable approval definitions specify trigger, amount/variance threshold, steps, eligible roles, segregation, delegation, expiry, and rejection path.
5. Audit viewer filters by actor/action/field/source/date and provides permission-controlled export.

### Reports and alerts

- Pending approvals, rejected/expired approvals, document completeness/expiry, privileged changes, manual overrides, reversals, and audit export history.
- Alerts for assigned approvals, approval expiry, missing/invalid document, privileged override, and suspicious export.

### Acceptance criteria and end-to-end tests

- File access is tenant/scope/visibility protected, malware/type/size checked, checksum tracked, stored in PostgreSQL for the current phase, and delivered through expiring backend authorization.
- Approval decisions include actor, role, timestamp, comment, and exact submitted snapshot; changing material data invalidates/restarts approval.
- Maker-checker segregation is enforced server-side.
- Audit events cannot be edited through product APIs and contain before/after values for governed fields.
- External comments/documents never expose internal-only content.

### Master prompt for Codex

> Implement **GOV-01 Documents, comments, audit, and approvals** from `FEATURES.md` following the Common Codex build contract. Add secure versioned PostgreSQL document storage/metadata behind a replaceable interface, record activity and visibility-aware comments, configurable snapshot-based approval workflows with segregation/delegation/rejection, immutable audit events/view/export, reports and alerts, and comprehensive tenant/scope/file-security/material-change tests. Provide reusable components/services consumed by all modules and do not add object-storage infrastructure.

---

## INT-01 — APIs, notifications, GPS, accounting, and migration connectors

**Status:** In progress

**Test status:** Implemented

**Outcome:** The platform integrates with existing systems and communication habits without making WhatsApp or spreadsheets the system of record.

### UX flow and integration details

1. Admin creates an integration with type, name, environment, endpoint/account, encrypted credential reference, scopes, allowed events, mapping version, rate limits, retry/dead-letter policy, and active state.
2. API clients use scoped credentials, idempotency keys, correlation IDs, pagination, versioned schemas, and auditable access.
3. Webhooks use signed payloads, event IDs, PostgreSQL-persisted retries/delivery logs, and replay controls.
4. Notification templates support in-app, email, SMS, and approved WhatsApp provider channels. Operational action links require authenticated authorization.
5. GPS adapters normalize provider pings into trip events and report provider/device freshness.
6. Accounting adapters export/import posted invoices, receipts, vendor bills, payments, tax/TDS data, and reconciliation results.
7. WhatsApp/Excel migration can ingest approved structured exports or assisted uploads; it must not scrape private chats or silently post messages.

### Reports and alerts

- Integration health, last success, throughput, latency, failures, retries, dead letters, webhook deliveries, rate-limit usage, mapping version, and reconciliation exceptions.
- Alert integration owners on authentication failure, schema mismatch, sustained failure, stale GPS, dead letter, or accounting mismatch.

### Acceptance criteria and end-to-end tests

- Duplicate API/webhook events with the same idempotency/event key produce one business effect.
- Secrets never appear in logs/UI/export and can be rotated without data loss.
- Failed deliveries retry with backoff and move to observable replayable dead-letter state.
- Mapping changes are versioned; historical payloads remain auditable.
- Notification recipients and action links enforce tenant and record scope.

### Master prompt for Codex

> Implement **INT-01 APIs, notifications, GPS, accounting, and migration connectors** from `FEATURES.md` and the Common Codex build contract. Build the reusable integration registry, encrypted secret references, scoped/versioned API foundation, signed idempotent webhooks with PostgreSQL-backed outbox/retry/dead-letter/replay state inside the backend deployment, notification template/channel abstraction, GPS and accounting adapter contracts, health/reconciliation views, alerts, and security/idempotency/failure-path tests. Add only safe stub adapters unless real provider credentials/specifications are already present, and add no new local infrastructure.

---

## CFG-01 — No-code tenant configuration and white-labeling

**Status:** In progress

**Test status:** Implemented

**Outcome:** The same product supports different logistics operators without forks or customer-specific constants.

### UX flow and configuration fields

1. Tenant Owner edits branding: product display name, logo, colors, support details, document headers, email sender identity, and portal labels.
2. Configure locale: timezone, currency, date/number display, fiscal period, tax identifiers, and numbering patterns.
3. Configure modules, role templates, code lists, location/truck/body/cargo types, delay/hold/deduction reasons, mandatory fields/documents, status thresholds, carryover rules, cancellation/fill policy, and approval policies.
4. Preview changes against sample records and an impact summary. Publish a version with reason and effective timestamp; rollback creates a new version.
5. Some safety-critical invariants remain platform controlled: tenant isolation, audit immutability, exact financial arithmetic, and authorization enforcement.

### Reports and alerts

- Configuration versions/diffs, unpublished changes, overrides from platform defaults, usage of deprecated codes, and records affected by a proposed rule change.
- Alerts on configuration publish, threshold/financial policy changes, incompatible integration mappings, or deprecated codes still in use.

### Acceptance criteria and end-to-end tests

- A second tenant can use different branding, reason lists, roles, thresholds, timezone, currency, and numbering without code changes or leakage.
- Published configuration versions are snapshotted or referenced by transactions so historical calculations remain reproducible.
- Invalid/ambiguous threshold ranges, duplicate active codes, and unsafe numbering patterns are rejected.
- Rollback is audited and does not rewrite historical transaction snapshots.
- Changing branding/config invalidates only the correct tenant frontend/backend state and PostgreSQL-derived projections.

### Master prompt for Codex

> Implement **CFG-01 No-code tenant configuration and white-labeling** from `FEATURES.md` using the Common Codex build contract. Build tenant branding/locale/module/code-list/reason/threshold/document/numbering/approval configuration, draft-preview-impact-publish-version workflow, transaction reproducibility, safe rollback-as-new-version, tenant state/projection isolation, configuration audit/reports/alerts, and multi-tenant end-to-end tests proving different tenants operate without code forks or leakage.

---

## 7. Cross-feature end-to-end journeys

These journeys supplement the feature-specific tests and must pass before the product can be considered operationally complete.

### E2E-01 — Happy path: contract to cash and vendor settlement

1. Create tenant, users/scopes, client/location, contract/lane/rates, vendor, compliant vehicle, and driver.
2. Submit indent; verify computed commitment and client rate/vendor cost snapshots.
3. Allocate vendor, accept offer, place vehicle within threshold, execute loading/transit/unloading, and complete delivery.
4. Receive/approve/submit POD.
5. Generate, approve, post, and acknowledge client invoice.
6. Post part receipt, verify open balance; post final receipt, verify closure.
7. Submit/approve vendor bill and post vendor payment.
8. Verify control-tower KPIs, ledgers, margin, alerts, documents, and audit all reconcile.

### E2E-02 — Placement breach and recovery

Create an indent that crosses Green, Yellow, and Red boundaries; verify one escalating alert, work-queue ownership, NTP reason, replacement allocation, late placement, stopped clock, dashboard drill-down, and retained history.

### E2E-03 — POD exception blocks billing/collection

Complete delivery with shortage/damage and missing POD; verify ageing/value-at-risk alerts, billing eligibility block according to contract, correction/approval, POD submission, invoice release, and exception audit trail.

### E2E-04 — Collection dispute and short receipt

Age an open invoice across collection boundaries, add follow-up and promise-to-pay, post a short receipt with deduction, verify part-paid balance and hold reason, approve credit/deduction, settle, and reconcile SOA/dashboard/ledger.

### E2E-05 — Import correction without duplication

Import each workbook dataset, reject a file with row errors, commit a corrected full file, resend the same file, then submit a changed row. Verify idempotency, cross-file joins, retained history, financial non-duplication, and import reconciliation.

### E2E-06 — Tenant and role isolation

Run all major screens, APIs, exports, files, alerts, searches, and jobs as users from two tenants and multiple scoped roles. Verify no unauthorized record, aggregate, identifier, file, notification, or sensitive field crosses tenant or scope.

### E2E-07 — Offline field operation

Perform loading and delivery milestones offline, reconnect, retry sync, create an ordering conflict, and verify a single set of business milestones, conflict visibility, original/received timestamps, POD task creation, and restricted location collection.

## 8. Definition of complete

A feature is **Complete** only when:

- Its UX, API, persistence, authorization, validation, calculations, audit, reports, alerts/events, migrations, and automated tests are implemented where applicable.
- All feature acceptance tests and affected cross-feature journeys pass.
- Metrics reconcile to detail data and exact boundary tests pass.
- Tenant isolation, scoped access, accessibility, responsive behavior, error/loading/empty states, idempotency, and failure recovery are verified.
- Documentation, configuration, seed/fixture data, API contracts, and this feature register are updated.
- No prototype-only simulated data or hard-coded Juri Gari business constants remain in production paths.

## 9. Decisions requiring product-owner confirmation

These are configuration decisions, not reasons to stop foundational implementation:

- Whether cancelled indents are excluded from fill rate in all cases or only selected cancellation reasons.
- Whether placement Green means any time up to 24 hours after the committed timestamp, as the supplied prototype computes, or strictly on/before the committed timestamp.
- Whether prior-calendar-month POD automatically becomes Red even when it is fewer than the configured Red-age threshold.
- Whether accepted client deductions reduce invoice outstanding through credit notes, write-offs, or both.
- Whether over-receipts are blocked or retained as on-account client credits.
- Required approval matrices and monetary/variance thresholds.
- Vendor rate/TDS/GST policies, bank verification method, and payment-file integrations.
- Required GPS, accounting, messaging, OCR, and identity providers.
- Data-retention, privacy, consent, and document requirements by operating geography.

## 10. Supplied workbook data dictionary

This section is the compatibility contract for the seven supplied Excel/form datasets. Product models may normalize these fields internally, but imports and exports must preserve their meaning and exact header text.

### 10.1 Client Master

| Field               | Requirement           | Input/rule                                                                   |
| ------------------- | --------------------- | ---------------------------------------------------------------------------- |
| Client Code         | Required              | Tenant-unique uppercase text with no spaces; stable join key.                |
| Client Name         | Required              | Text.                                                                        |
| Industry            | Optional              | Text or configurable industry master.                                        |
| Account Manager     | Required              | Active scoped employee; prototype values `PHANI`, `NAND` become tenant data. |
| Billing Entity      | Optional/defaulted    | Tenant legal entity; prototype default `Jurigari Private Limited`.           |
| GSTIN               | Optional/configurable | Validate format when supplied.                                               |
| Credit Days         | Required              | Non-negative whole number; default 45 in prototype.                          |
| POD Submission Mode | Optional              | `Portal`, `Hard copy`, `Email`, `Portal + Hard copy`, tenant configurable.   |
| Escalation Name     | Optional              | Text.                                                                        |
| Escalation Email    | Optional              | Valid email when supplied.                                                   |
| Active              | Optional/defaulted    | `Y`/`N`, default `Y`.                                                        |

### 10.2 Location Master

| Field                         | Requirement        | Input/rule                                                                 |
| ----------------------------- | ------------------ | -------------------------------------------------------------------------- |
| Client Code                   | Required           | Must reference an active/known client on create.                           |
| Location Code                 | Required           | Tenant-unique; recommended `CLIENT-LOC`.                                   |
| Location Name                 | Required           | Text.                                                                      |
| State                         | Optional           | Geography value.                                                           |
| Location Type                 | Optional           | `Plant`, `Depot`, `DC`, `Warehouse`, `CFA`, `Market`, tenant configurable. |
| Committed Placement TAT (Hrs) | Required           | Positive whole hours; prototype default 24.                                |
| Branch Manager                | Optional           | Active scoped employee.                                                    |
| Traffic Manager               | Optional           | Employee/person reference.                                                 |
| Traffic Manager Mobile        | Optional           | Valid mobile when supplied.                                                |
| Active                        | Optional/defaulted | `Y`/`N`, default `Y`.                                                      |

### 10.3 Vendor Master

| Field                   | Requirement           | Input/rule                                                                    |
| ----------------------- | --------------------- | ----------------------------------------------------------------------------- |
| Vendor Code             | Required              | Tenant-unique; recommended `VEN-nnnn`.                                        |
| Vendor Name             | Required              | Text.                                                                         |
| Owner Name              | Optional              | Text.                                                                         |
| Base Location Code      | Optional              | Known location; support vendor-native base geography in the normalized model. |
| Contact 1               | Required              | Valid mobile/contact.                                                         |
| Contact 2               | Optional              | Valid mobile/contact.                                                         |
| PAN                     | Optional/configurable | Validate and protect as sensitive data.                                       |
| GSTIN                   | Optional/configurable | Validate and protect as sensitive data.                                       |
| Fleet Size              | Optional              | Non-negative whole number.                                                    |
| Truck Types Served      | Optional              | Workbook uses semicolon-separated configured truck types.                     |
| Onboarded By (Emp Code) | Required              | Active/known employee; recommended `JGL-nnn`.                                 |
| Onboarded By (Name)     | Required for workbook | Must reconcile to employee code or be flagged.                                |
| Onboarding Date         | Required              | Date.                                                                         |
| Active                  | Optional/defaulted    | `Y`/`N`, default `Y`.                                                         |

### 10.4 Indent & Placement

| Field                           | Requirement               | Input/rule                                          |
| ------------------------------- | ------------------------- | --------------------------------------------------- |
| Indent No                       | Required                  | Tenant-unique and never reused.                     |
| Indent Date & Time              | Required                  | Starts placement commitment calculation.            |
| Client Code                     | Required                  | Known client.                                       |
| Location Code                   | Required                  | Known location belonging to Client Code.            |
| Origin                          | Required                  | Text/geography.                                     |
| Destination                     | Required                  | Text/geography.                                     |
| Truck Type                      | Required                  | Configured code.                                    |
| Qty / Weight (MT)               | Optional                  | Non-negative decimal.                               |
| Committed Placement Date & Time | Required                  | Defaults from SLA/TAT; override is governed.        |
| Vendor Code                     | Optional until allocation | Known eligible vendor when supplied.                |
| Vehicle No                      | Required when Placed      | Known/eligible vehicle or validated registration.   |
| Driver Name                     | Optional until Placed     | Prefer driver reference; workbook exports name.     |
| Driver Mobile                   | Optional until Placed     | Prefer driver reference; validate when supplied.    |
| Actual Placement Date & Time    | Required when Placed      | Blank while awaited/NTP; stops placement ageing.    |
| Placement Status                | Required                  | `Placed`, `Awaited`, `NTP`, `Cancelled`.            |
| NTP / Delay Reason              | Conditional               | Configured reason; expected for NTP/late exception. |
| Remarks                         | Optional                  | Text; preserve audit/history.                       |

### 10.5 POD Register

| Field                        | Requirement           | Input/rule                                                                                             |
| ---------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------ |
| LR No                        | Required              | Unique delivery/shipment key within configured scope.                                                  |
| Indent No                    | Optional in prototype | Must reference known indent when supplied.                                                             |
| Client Code                  | Required              | Known client.                                                                                          |
| Location Code                | Required              | Known client location.                                                                                 |
| Invoice No                   | Required by workbook  | Links to invoice/opening invoice; normalized workflow may allow POD before billing and add link later. |
| Invoice Date                 | Optional              | Date; must match linked invoice when present.                                                          |
| Vehicle No                   | Required              | Registration/vehicle reference.                                                                        |
| Truck Type                   | Optional              | Configured code; reconcile to trip when present.                                                       |
| Loading Date                 | Required              | Must not be after delivery without governed correction.                                                |
| Delivery Date                | Required              | Starts POD ageing.                                                                                     |
| POD Received Date            | Optional              | Blank while pending; stops POD ageing.                                                                 |
| POD Submitted to Client Date | Optional              | Requires received POD unless policy allows digital direct submission.                                  |
| POD Mode                     | Optional              | `Soft copy`, `Hard copy`, `Portal upload`, tenant configurable.                                        |
| Receiver Name                | Optional              | Text.                                                                                                  |
| Stamp Present                | Optional              | `Y`/`N`.                                                                                               |
| Shortage / Damage Remarks    | Conditional           | Required when discrepancy/hold exists.                                                                 |

### 10.6 Invoice & Collection

| Field                     | Requirement                            | Input/rule                                                                                                        |
| ------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Invoice No                | Required                               | Tenant/legal-entity unique; immutable after posting.                                                              |
| Invoice Date              | Required                               | Date.                                                                                                             |
| Submission Date to Client | Required by workbook                   | Client acknowledgement date; starts collection ageing. Production draft invoices may be blank until acknowledged. |
| Client Code               | Required                               | Known client.                                                                                                     |
| Location Code             | Required                               | Known client location.                                                                                            |
| Billing Month             | Optional                               | Display period such as `Jun-26`; normalized as a period value.                                                    |
| Taxable Value             | Required                               | Exact non-negative decimal.                                                                                       |
| GST Amount                | Optional/defaulted                     | Exact decimal, derived from tax lines where applicable.                                                           |
| Total Invoice Amount      | Calculated/accepted on import          | Taxable value + GST/charges − credits; imported value must reconcile.                                             |
| Credit Days               | Optional/defaulted                     | Snapshot from client/contract.                                                                                    |
| Due Date                  | Calculated                             | Submission acknowledgement + credit days.                                                                         |
| Payment Received          | Calculated/accepted as opening balance | Derived from posted receipts; workbook import value requires reconciliation mode.                                 |
| Balance Due               | Calculated/accepted on import          | Total − settled transactions; imported value must reconcile.                                                      |
| Last Payment Date         | Calculated/accepted on import          | Latest posted receipt allocation date.                                                                            |
| Hold / Deduction Reason   | Conditional                            | Required for configured open/disputed conditions.                                                                 |
| SOA Reference             | Optional                               | Text/document reference.                                                                                          |
| Followed Up On            | Optional/calculated                    | Latest collection follow-up date in normalized model.                                                             |

### 10.7 Payment Receipts

| Field               | Requirement          | Input/rule                                                                     |
| ------------------- | -------------------- | ------------------------------------------------------------------------------ |
| Receipt Ref         | Required             | Tenant-unique/idempotent external reference.                                   |
| Invoice No          | Required by workbook | Known invoice; normalized UI also permits a receipt allocated across invoices. |
| Client Code         | Required             | Must match invoice client.                                                     |
| Payment Date        | Required             | Date; prototype defaults to current local date.                                |
| Amount Received     | Required             | Positive exact decimal.                                                        |
| Mode                | Required             | `NEFT`, `RTGS`, `IMPS`, `Cheque`, `UPI`, `Adjustment`, tenant configurable.    |
| UTR / Instrument No | Conditional          | Required according to payment mode/policy; duplicate detection applies.        |
| Deduction Amount    | Optional/defaulted   | Non-negative exact decimal, default zero.                                      |
| Deduction Reason    | Conditional          | Required when deduction amount is positive.                                    |
| Reconciled (Y/N)    | Optional/defaulted   | `Y`/`N`, default `N`; maps to governed reconciliation status.                  |

### 10.8 Supplied exact code lists

| List                    | Supplied values                                                                                                                                                                                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Truck Type              | `10 ft`, `14 ft`, `17 ft`, `19 ft`, `22 ft`, `32 ft SXL`, `32 ft MXL`, `20 ft container`, `40 ft container`                                                                                                                                                                          |
| Placement Status        | `Placed`, `Awaited`, `NTP`, `Cancelled`                                                                                                                                                                                                                                              |
| NTP / Delay Reason      | `Vehicle breakdown`, `Rate not agreed`, `No vehicle in market`, `Loading delay at plant`, `Driver unavailable`, `Client cancelled`, `Permit / documentation`                                                                                                                         |
| POD Mode                | `Soft copy`, `Hard copy`, `Portal upload`                                                                                                                                                                                                                                            |
| Payment Mode            | `NEFT`, `RTGS`, `IMPS`, `Cheque`, `UPI`, `Adjustment`                                                                                                                                                                                                                                |
| Hold / Deduction Reason | `Shortage claim under verification`, `POD copy awaited at client end`, `Rate difference, revised bill raised`, `Detention not approved`, `Damage debit note raised`, `GRN mismatch at plant`, `Awaiting SCM head approval`, `Invoice not booked in client system`, `No reason given` |
