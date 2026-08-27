# OPS-02 — Allocation and placement workbench UX completion

**Status:** Implemented
**Evidence reviewed:** current allocation/rule APIs and UI, `FEATURES.md`, and the placement views in `backup/dashboard.html`. No tests were run.

**Focused correction:** `BUG-OPS-021` corrected the auto-allocation register authorization-expression syntax. PostgreSQL `EXPLAIN` accepts the tenant-scoped query; `OPS-WB-11` is Implemented / Not Run.

## Problem and outcome

Allocation APIs and basic CTAs exist, but the product needs one complete, filterable allocation register and contextual workflows for offer, assignment, replacement, placement, NTP, cancellation, and automatic-allocation rules. Dispatchers must finish allocation without raw IDs, prompts, or disconnected pages.

## Scope and dependencies

- `/app/operations/allocations`: all scope-visible allocations, including terminal records when requested.
- Inline/drawer actions: manual allocate, vendor accept/reject/expire, vehicle/driver assign or replace, place, NTP, cancel, create trip.
- Auto-allocation rule list, create/edit/enable/disable, dry-run preview and confirmed execution.
- Depends on OPS-01 and MST-03 eligibility/compliance/bank-independent supply masters. Trip creation hands off to OPS-03.

## Actors, authorization, and scope

- `operations.read` sees permitted allocation fields and eligibility explanations.
- `operations.admin` allocates/transitions; configured vendor users may accept/reject only their own offered allocations; assignment/override capabilities may be separated.
- Tenant, branch/client/location/vendor and assigned-record predicates are server-derived on lists, counts, eligibility, mutations and exports.
- Ineligible choices are either excluded with a reason summary or displayed disabled with an accessible explanation; the backend always revalidates.

## UX behavior and states

1. Tabs/subviews: Active allocations, Awaiting vendor, Assignment pending, Placement risk/NTP, Completed/Cancelled, and Auto-allocation rules. Each is a filter over one canonical register.
2. KPIs show allotted, accepted, assigned, placed, NTP, rejected/expired, remaining demand and fill rate. Clicking opens reconciled rows.
3. Register includes indent, client/location/lane, commitment/risk, vendor, allotted/placed quantity, offer timestamps/status, vehicle, driver, owner, reporting time, placement/NTP state/reason, and actions.
4. Allocate truck starts from an indent and displays remaining demand, eligible vendors, offered rate/cost snapshot (permission gated), quantity, expiry/channel, owner and notes. Split allocations are supported.
5. Offer CTAs appear only for valid state/actor: Accept, Reject with reason, Expire (system/authorized correction), or Resend through notification seam.
6. Assign uses searchable eligible vehicle and driver controls. Replace captures reason and displays old/new assignment history. Assignment is not accepted if eligibility changed before commit.
7. Place requires actual reporting time and vehicle/driver; NTP requires reason; cancel requires reason and releases quantity. Create trip appears only after a valid placed/assigned allocation according to tenant policy.
8. Auto-rule editor uses reference selectors and structured priority/weight fields, not JSON. Preview shows ranked vendors, exclusions, quantities and projected result without writes. Execute requires confirmation and an idempotency key.
9. Loading, empty, error/retry, no-eligible-supply, stale-version, rule-conflict and partial-success states preserve register context and announce outcomes.

## Data and invariants

- Reuse normalized allocations, offer responses, assignment history, eligibility evidence, placement events, rules, audit and idempotency tables.
- Lock indent demand while allocating. Sum of active allotted quantities cannot exceed uncancelled demand. Rejection/expiry/cancellation releases quantity exactly once.
- `PLACED` requires eligible vehicle/driver and reporting timestamp. Replacement appends history; it does not rewrite the original.
- Vendor cost and eligibility are snapshotted at decision time. Quantities and money remain exact.

## API/events

- Existing `GET /operations/allocations` supports search, state/risk/vendor/client/location/date/sort/page and returns allowed actions plus pagination/as-of metadata.
- Existing manual, transition, assign, rule preview and execute routes remain typed/versioned. Add detail/history endpoint and explicit replacement/offer response commands if current transition payload cannot capture evidence safely.
- Mutations require CSRF, idempotency, expected version, audit and same-transaction outbox events (`allocation.offered/responded/assigned/replaced/placed/ntp/cancelled`).

## Reports, alerts, audit, observability, recovery

- Allocation/fill/vendor/NTP metrics and export reconcile to visible rows; placement lens consumes the same canonical query.
- Alerts: offer expiry/rejection, supply unavailable, assignment eligibility loss, approaching/breached commitment, replacement, and unresolved NTP.
- Audit includes actor, reason, before/after identifiers, eligibility decision, cost snapshot version and correlation key with sensitive fields masked.
- Lock/version conflicts return refreshable conflict details; notification failure leaves the committed allocation queued for retry; rule execution records per-indent outcome and permits safe replay.

## Acceptance criteria

- **OPS02-AC01:** The Allocations tab is a complete paginated register with state/risk/reference filters, counts and state-valid actions for current and historical allocations.
- **OPS02-AC02:** A dispatcher can allocate remaining indent demand from the landing row, including split allocation, without entering an ID or JSON.
- **OPS02-AC03:** Offer accept/reject/expiry, assignment/replacement, place/NTP/cancel and Create trip are exposed only in valid states and are revalidated server-side.
- **OPS02-AC04:** Exact quantities reconcile after concurrent partial allocation, rejection, expiry, placement and cancellation; active allocation cannot exceed demand.
- **OPS02-AC05:** Eligible vendor/vehicle/driver search is scoped and explainable; stale or ineligible assignment is blocked at commit.
- **OPS02-AC06:** Rule create/edit/toggle/preview/execute is structured, versioned and idempotent; preview never mutates data.
- **OPS02-AC07:** Vendor allocation cards, fill KPIs, register, Control Tower drill and visible export reconcile with the prototype fields and canonical rows.
- **OPS02-AC08:** Desktop/mobile, keyboard, loading, empty, error/retry and conflict states are operable and preserve filter context.

## Assumptions and readiness

Offer expiry duration and replacement approval are tenant configuration. No blocking decision remains. Production behavior is implemented and independently reviewed; focused contract/Playwright cases are `Implemented / Not Run`, with deeper cases tracked as `Planned` in the batch test plan.
