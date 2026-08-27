# OPS/FIN/CTL UX Completion — Test Plan

**Plan status:** Detailed
**Overall test status:** Planned
**Related features:** `OPS-01`, `OPS-02`, `OPS-03`, `DOC-01`, `FIN-01`, `FIN-02`, `FIN-03`, `CTL-01`
**Related specs:** `specs/OPS-01/spec.md`, `specs/OPS-02/spec.md`, `specs/OPS-03/spec.md`, `specs/FIN-01/spec.md`, `specs/FIN-02/spec.md`, `specs/FIN-03/spec.md`, and `specs/CTL-01/spec.md`

This plan covers the requested Operations and Finance landing workbenches and the Control Tower parity work evidenced by `backup/dashboard.html`. Existing generic CRUD coverage in `tests/e2e/all-features-operations-finance.spec.ts` does not satisfy these workflow journeys.

## Critical risks

- A visible CTA may bypass the server-side role, scope, tenant, eligibility, or maker-checker boundary.
- Concurrent or repeated allocation, trip, invoice, receipt, or payment actions may duplicate canonical or ledger effects.
- Dashboard counts, risk colours, and money totals may be derived from display data rather than canonical records and append-only ledgers.
- A workflow may expose an impossible transition, omit recovery, or mutate a posted financial record.
- Search, filters, saved views, drill-downs, and CSV export may disagree or leak records across tenants/scopes.
- Time boundaries may use browser time rather than UTC plus tenant timezone; financial values may lose paise precision.

## Deterministic fixtures and environment

Use the real frontend, backend, and shared PostgreSQL test schema. Business API mocking, route interception, production data, and arbitrary sleeps are prohibited.

- Fixed clock: `2026-08-27T06:30:00.000Z` (`2026-08-27 12:00 Asia/Kolkata`); tenant currency `INR`, timezone `Asia/Kolkata`.
- `UXA` and `UXB`: independent tenants with identical-looking client/vendor/reference codes to prove tenant isolation.
- UXA users: Tenant Owner, Traffic/Placement Executive, Finance Executive, Collection Executive, Vendor Owner, Driver, Client Viewer, Auditor; include one regional user and one client-scoped KAM.
- UXA masters: two clients, three locations in two regions, two published contracts/rate snapshots, two eligible vendors, one expired-compliance vendor, three vehicles, and three drivers. UXB mirrors codes but not IDs.
- Operations fixture: six open indents (including quantity 2 split across vendors), one draft indent, one cancelled indent, allocations in `OFFERED`, `ACCEPTED`, `VEHICLE_ASSIGNED`, `PLACED`, and `NTP_RELEASED`, and trips in every actionable state. Exact placement ages sit immediately below/at/above 24 and 48 hours.
- Document fixture: delivered trips with POD received, pending 7/15-day boundaries, and prior-period carryover; one invoice linked through duplicate LR rows to prove value deduplication.
- Client finance fixture: eligible/unbilled services; invoices in Draft, Pending Approval, Approved, Posted, Submitted/Acknowledged, Part Paid, Paid, Hold, and Reversed states. Use line values `₹1,000.01 + ₹2,000.02`, tax `₹540.01`, total `₹3,540.04` (`354004` minor units).
- Receipt fixture: `₹1,500.02` allocated to two invoices, one `₹50.01` deduction, one unallocated balance, unique UTRs, and ageing at exactly 30/31/45/46 days.
- Vendor finance fixture: exact rate-snapshot payable, GST/TDS/deduction/advance amounts, one disputed bill, one verified and one changed bank account, and payment runs in every actionable state.
- Each test creates namespaced records through supported fixture APIs, records their IDs, and cleans only its namespace. Parallel workers receive independent tenant/data namespaces.
- Wait on response status, persisted state, event/audit row, or rendered state. Never wait by elapsed sleep.

## Acceptance-to-test matrix

| Test ID          | Acceptance/risk                                           | Layer                     | Action and expected result                                                                                                                                                                                                               | Status                |
| ---------------- | --------------------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| OFC-OPS-E2E-001  | Operations landing shows all open indents                 | Playwright/API/PostgreSQL | Open `/app/operations`; KPI and urgency-ordered queue equal canonical open-indents query, excluding draft/cancelled/foreign records; empty/loading/error/retry states are usable.                                                        | Implemented / Not Run |
| OFC-OPS-E2E-002  | Create/update entry points                                | Playwright                | From landing select **Create or update indent**, create an indent with reference selectors and date-time controls, then update an allowed field with optimistic version; queue and detail refresh to the persisted value.                | Implemented / Not Run |
| OFC-OPS-E2E-003  | Allocate truck from an open indent                        | Playwright/API            | Select **Allocate truck** on an open indent, see only eligible scoped vendors, allocate less than requested quantity, and verify remaining demand, allocation tab, audit, and fill totals. CTA is absent/disabled for ineligible states. | Implemented / Not Run |
| OFC-OPS-E2E-004  | Manual allocation state machine                           | Playwright/API            | Exercise Offer → Accept → assign eligible vehicle/driver → NTP/Placed; impossible transitions and placed-without-vehicle/time fail without partial mutation.                                                                             | Implemented / Not Run |
| OFC-OPS-E2E-005  | Auto-allocation rule lifecycle                            | Playwright/API            | Create/edit/disable a rule, preview without mutation, then execute once; ranking/exclusion explanations are visible and execution creates only the selected eligible allocation.                                                         | Planned               |
| OFC-OPS-API-006  | Allocation idempotency and concurrency                    | API/PostgreSQL            | Repeat one idempotency key and race two allocations against the same remaining quantity; retry returns original and locking permits no over-allocation or duplicate event.                                                               | Planned               |
| OFC-OPS-E2E-007  | Allocation register and filters                           | Playwright                | Allocation tab lists all permitted allocations with status/client/vendor/risk filters, searchable references, actionable rows, accurate empty result, and URL/filter persistence where supported.                                        | Implemented / Not Run |
| OFC-OPS-E2E-008  | Trip creation and all requested CTAs                      | Playwright/API            | From a placed allocation create one trip, then use **Accept trip**, **Start / gate-in**, loading/transit actions, and **End & deliver**; each next CTA reflects persisted state and delivery produces one POD task.                      | Implemented / Not Run |
| OFC-OPS-API-009  | Trip transition conflict, retry, and assignment isolation | API/PostgreSQL            | Duplicate offline/event key converges, stale/racing action returns conflict, reassigned driver loses action access, new driver gains it, and event history remains append-only.                                                          | Planned               |
| OFC-OPS-AUTH-010 | Operations tenant/role/scope isolation                    | API/Playwright            | UXB, Vendor Owner, Driver, regional user, and KAM attempt list, direct-ID, CTA, and export access; each sees/changes only authorized tenant and scope with no identifier leakage.                                                        | Implemented / Not Run |
| OFC-OPS-UNIT-011 | Placement/fill/time boundaries                            | Unit/integration          | Assert exact 24h/48h G/Y/R boundaries, tenant-time display, partial/cancelled demand denominator, placed/pending/NTP totals, and no double counting after replacement.                                                                   | Planned               |
| OFC-FIN-E2E-012  | Finance landing pending-work dashboard                    | Playwright/API            | Open `/app/finance`; pending invoice, collection, vendor-bill, unbilled-service, and payment-run queues/KPIs match canonical PostgreSQL results; drill links open the matching filtered tab.                                             | Implemented / Not Run |
| OFC-FIN-E2E-013  | Create invoice from eligible services                     | Playwright/API            | Select actual delivered/POD-eligible services, preview exact charges, create draft, and verify linked service/rate snapshot and minor-unit total `354004`; ineligible/duplicate services cannot be selected or billed.                   | Implemented / Not Run |
| OFC-FIN-E2E-014  | Invoice queue and all lifecycle CTAs                      | Playwright/API            | On invoice tab use Submit, Approve, Post, Acknowledge, follow-up/hold where offered, and Reverse on eligible rows; buttons track state and posted number/lines remain immutable.                                                         | Implemented / Not Run |
| OFC-FIN-AUTH-015 | Invoice maker-checker and scope                           | API/Playwright            | Maker cannot approve own invoice; Finance Executive/Client Viewer/Auditor receive their defined read/action scope; KAM/client scope and UXB cannot discover or mutate other records.                                                     | Implemented / Not Run |
| OFC-FIN-API-016  | Invoice idempotency/concurrency                           | API/PostgreSQL            | Duplicate create/post requests and two approvers converge to one invoice/posting/outbox event; stale version loses without overwriting.                                                                                                  | Planned               |
| OFC-FIN-INT-017  | Due date and exact client ledger                          | Integration               | Acknowledgement date plus snapshotted credit days determines due date; line/tax/total, notes/reversal, unbilled service, register, and accounting reconciliation balance exactly in minor units.                                         | Planned               |
| OFC-FIN-E2E-018  | All-invoice register, filters, drill and recovery         | Playwright                | All invoices tab searches and filters status/client/due/risk, opens detail, displays no raw JSON, handles empty/error/retry, and returns to preserved filters after an action.                                                           | Implemented / Not Run |
| OFC-FIN-E2E-019  | Collections dashboard and receipt allocation              | Playwright/API            | Prioritized open invoices show due/value/colour/owner; allocate a real receipt across invoices with deduction, verify remaining/unallocated amounts, and record a follow-up/promise.                                                     | Implemented / Not Run |
| OFC-FIN-INT-020  | Receipt ledger, reversal, duplicates, boundaries          | Integration/API           | Duplicate UTR/import is idempotent; over-allocation rejects; reversal appends compensating entries; balances and exact 30/31/45/46-day colours reconcile across invoice, receipt, SOA, and dashboard.                                    | Planned               |
| OFC-FIN-E2E-021  | Vendor bill and payment CTAs                              | Playwright/API            | Create bill from eligible trip, then Submit, operational Verify, finance Approve, create/approve/submit/mark-paid payment, Dispute/Fail/Reverse exception paths, and verify remittance/ledger state.                                     | Implemented / Not Run |
| OFC-FIN-AUTH-022 | Vendor bill/payment integrity and isolation               | API/PostgreSQL            | Self-approval, unverified/changed bank, duplicate vendor invoice/trip, wrong vendor, foreign tenant, and unauthorized role fail; original bill/payment stays intact and sensitive bank fields stay masked.                               | Implemented / Not Run |
| OFC-FIN-REC-023  | Vendor payable and margin reconciliation                  | Integration               | GST, TDS, deductions, advances, payments, reversals, outstanding, and contribution margin match rate snapshots and ledger rows exactly in minor units.                                                                                   | Planned               |
| OFC-CTL-E2E-024  | Prototype-parity lenses                                   | Playwright/API            | Placement, POD vs Invoice, Collection, Trip, and Vendor Payable tabs render canonical KPI cards, definitions, rows, freshness/as-of, and appropriate vendor allocation summary—never simulated data.                                     | Implemented / Not Run |
| OFC-CTL-E2E-025  | Three-level drill and breadcrumbs                         | Playwright                | For each applicable lens drill client → location → record, then navigate breadcrumbs back; record totals and worst-child colour reconcile at every level.                                                                                | Implemented / Not Run |
| OFC-CTL-E2E-026  | Search/filter/saved view/pause-resume                     | Playwright/API            | Search reference/client/location/vehicle, filter G/Y/R, save/apply view, switch lens, pause and resume refresh; filters/drill behave as specified and no arbitrary polling assertion is used.                                            | Implemented / Not Run |
| OFC-CTL-E2E-027  | Visible CSV export                                        | Playwright/API            | Download after scope/search/risk/drill filters; parsed CSV rows and exact money/status columns equal the visible authorized canonical result set and contain no foreign rows.                                                            | Implemented / Not Run |
| OFC-CTL-REC-028  | KPI and report reconciliation                             | Integration/API           | Independently aggregate PostgreSQL fixtures for placement/fill/NTP, POD closure/value at risk with invoice deduplication, collection balance/ageing, trip exception, and vendor payable; every KPI and drill total matches.              | Planned               |
| OFC-CTL-AUTH-029 | Control Tower tenant/role/scope isolation                 | API/Playwright            | UXB and scoped roles attempt each lens, saved view, direct filter IDs, drill and export; results are tenant/server-scope derived and forbidden money/margin data is absent or masked.                                                    | Implemented / Not Run |
| OFC-DB-MIG-030   | Forward-safe migration and pre-existing records           | Migration/integration     | Apply the batch migration to a pre-workbench database with canonical records, rerun deploy, and verify no loss/duplication, safe defaults/backfill, constraints, indexes, ownership and runtime privileges.                              | Planned               |
| OFC-AUD-INT-031  | Audit/outbox completeness and failure recovery            | Integration               | Each material CTA records tenant, actor, action, before/after/reference and correlation/idempotency evidence; injected transaction/outbox failure rolls back atomically and a retry succeeds once.                                       | Planned               |
| OFC-A11Y-E2E-032 | Accessibility and responsive usability                    | Playwright/Axe            | Desktop and small-screen journeys use headings, landmarks, labels, keyboard-operable tabs/dialogs/tables/menus, focus return, announced loading/errors, non-colour risk text, horizontal table containment, and no serious Axe findings. | Implemented / Not Run |

## Executable test targets

Implementation should keep IDs stable and split by ownership without duplicating fixtures:

- `tests/e2e/operations-workbench.spec.ts`: `OFC-OPS-E2E-*`, `OFC-OPS-AUTH-*`, and browser portion of `OFC-A11Y-E2E-032`.
- `tests/e2e/finance-workbench.spec.ts`: `OFC-FIN-E2E-*`, `OFC-FIN-AUTH-*`, and browser portion of `OFC-A11Y-E2E-032`.
- `tests/e2e/control-tower-workbench.spec.ts`: `OFC-CTL-E2E-*`, `OFC-CTL-AUTH-*`, and browser portion of `OFC-A11Y-E2E-032`.
- Backend/package tests should carry the matching `OFC-*-API`, `OFC-*-INT`, `OFC-*-REC`, `OFC-DB-MIG`, and `OFC-AUD-INT` IDs in their test titles.

## Playwright journey rules

Provision fixtures through supported test/setup APIs, but perform the behavior named by each E2E case through the UI. Assert the mutating response and then query the real API/database projection. Downloads must be parsed and reconciled. Failure tests must assert no partial database, ledger, audit, or outbox mutation. Use semantic role/label locators and observable waits only.

## Commands for an explicit batch/release test phase only

Do not execute during planning or authoring.

```bash
pnpm exec playwright test tests/e2e/operations-workbench.spec.ts --project=chromium
pnpm exec playwright test tests/e2e/finance-workbench.spec.ts --project=chromium
pnpm exec playwright test tests/e2e/control-tower-workbench.spec.ts --project=chromium
make test
```

## Coverage readiness

- [x] Primary paths and every requested Operations/Finance CTA are mapped.
- [x] Exact domain boundaries, state transitions, tenant/role isolation, invalid input, concurrency, idempotency, migration, audit, failure recovery, accessibility, and reconciliation are explicit.
- [x] Fixtures are deterministic, tenant-isolated, and use real PostgreSQL/API/browser paths.
- [x] The listed Playwright cases are authored as `Implemented / Not Run`; deeper API/integration/reconciliation/migration cases remain `Planned`. No test was executed in this task.
