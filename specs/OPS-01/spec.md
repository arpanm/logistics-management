# OPS-01 — Operations landing and indent lifecycle UX completion

**Status:** Implemented
**Batch:** Operations, Finance, and Control Tower UX completion
**Evidence reviewed:** `FEATURES.md`, `TODO.md`, current operations routes/controllers/services, and `backup/dashboard.html`. No tests were run.

## Problem and outcome

The Operations landing page exposes summary counts and a shortened urgent queue, while creation, updates, cancellation, and allocation are split across pages or unavailable as contextual forms. The landing page must be the daily workbench: every scope-visible open indent is discoverable and each valid next action is available from its row without copying identifiers.

## In scope

- `/app/operations` landing dashboard with risk KPIs and a complete open-indent register.
- Create, view, edit, submit/reopen, cancel, and allocate-truck actions from the dashboard.
- The same complete indent register at `/app/operations/indents` with saved URL filters.
- Loading, empty, partial/error, retry, stale/version-conflict, success, and permission-denied states.

## Out of scope

Vendor allocation internals are OPS-02; trip execution is OPS-03. Import/API ingestion remains DAT-01/INT-01, but imported records appear in this register.

## Dependencies and assumptions

- Depends on FND-02, MST-01, MST-02, and current typed operations tables/API.
- “Open indent” means `OPEN` or `PARTIALLY_ALLOCATED`; cancelled and fulfilled demand is excluded from open KPI denominators.
- Safe configurable assumption: the dashboard defaults to risk order (breached first, then nearest commitment) and tenant timezone; users may change sort/filter without changing canonical state.

## Actors, permissions, and scopes

- `operations.read`: view KPIs/register/detail/export inside effective legal-entity, region, branch, client, and location scope.
- `operations.admin`: create/edit/submit/cancel and initiate allocation inside the same scope.
- Commercial rate/margin fields remain projected only when the actor has the corresponding commercial capability.
- Direct API access, counts, searches, selectors, and exports apply the same server-derived tenant/scope predicate. Disabled CTAs explain the missing capability or state rule.

## UX flow and states

1. Landing header shows Open indents, Unassigned, Partially allocated, Commitment at risk/breached, requested vehicles, allocated vehicles, and fill rate, each linking to an equivalent filtered register.
2. Toolbar provides Create indent, search, client/location/lane/truck/status/risk/owner/date filters, sort, reset, refresh, and accessible pagination. Filters are reflected in the URL.
3. Register columns include risk, indent no/date, client/location, origin/destination, truck/cargo, requested/allocated/remaining, pickup window, committed placement, owner, state, version, and actions.
4. Create opens a drawer/page with search-select references, calendar/date-time controls, INR/IST tenant defaults, inline errors, computed SLA commitment preview, and explicit optional-field labels. No JSON or raw IDs are requested.
5. View/Edit preloads current values. Mutable fields are state-dependent; saved edits send `expectedVersion`. A `409` presents refresh/reapply rather than overwriting.
6. Cancel captures cancelled quantity, reason, client confirmation, and vendor-cost applicability. Partial cancellation preserves fulfilled/allocated quantities and history.
7. Allocate truck opens the OPS-02 allocation flow for that row in context and returns to the same filtered dashboard.
8. Loading uses labelled skeletons; empty views distinguish no data from no filter matches; API failure preserves filters and offers retry; successful mutation refreshes only affected KPI/register data and announces status.

## Data model, invariants, and migration

- Reuse canonical indent, SLA/commercial snapshots, ownership, cancellation, allocation, audit, and idempotency records.
- Add only forward-safe indexes/projections needed for scoped search, risk sort, open-state pagination, and KPI reconciliation.
- Tenant indent number is unique. Requested, cancelled, allocated, and remaining quantities are exact and non-negative; active allocations cannot exceed uncancelled demand.
- Historical snapshots and workflow/audit rows are never replaced by edits.

## API, events, and idempotency

- Extend `GET /operations/dashboard` to accept the register filters/sort/page and return `{asOf, summary, items, page}`; summary and rows must use one scoped filter contract.
- `GET /operations/indents/:id` returns projected detail and allowed actions. Existing create/transition APIs remain; add a versioned edit command if absent.
- All mutations require CSRF and `Idempotency-Key`; same key/body returns the first result and different body conflicts.
- Submit/cancel/update writes audit plus outbox event in the same transaction. Failed downstream alert delivery does not roll back the indent.

## Reports, alerts, audit, and observability

- KPI/register/export totals reconcile. New/unowned/approaching/breached/missing-master conditions publish canonical alert inputs.
- Audit records before/after, actor, source, reason, correlation/idempotency key, and version without leaking restricted commercial data.
- Log/metric dimensions use tenant-safe identifiers, action, state, latency, and failure code; never payloads containing PII.

## Failure recovery

- Invalid references or deactivated masters return field errors and updated selectors.
- Concurrent allocation/edit is rechecked under database lock. A recoverable conflict leaves the drawer populated.
- KPI projection lag is surfaced with `asOf/freshness`; canonical detail remains authoritative.

## Acceptance criteria

- **OPS01-AC01:** `/app/operations` lists every scope-visible open indent through pagination, not only a fixed urgent subset, and each KPI opens the exactly matching rows.
- **OPS01-AC02:** Authorized users can create, view, edit, submit/reopen, cancel, and launch Allocate truck from the landing row; unauthorized or invalid-state actions are absent/disabled and denied server-side.
- **OPS01-AC03:** Create/edit uses typed controls and searchable references, computes commitment from the effective SLA, and records governed override reason.
- **OPS01-AC04:** Partial allocation/cancellation yields exact requested, allocated, cancelled, remaining, and fill totals without double counting.
- **OPS01-AC05:** Duplicate create retries are idempotent; duplicate indent numbers fail; stale edits never overwrite a newer version.
- **OPS01-AC06:** Filters, sort, pagination, empty/error/retry states, keyboard focus, mobile cards/table, and return from allocation preserve user context.
- **OPS01-AC07:** Dashboard, register and visible export reconcile under identical tenant/authorization filters.

## Open decisions

None blocking. Page size, risk thresholds, visible columns, and default saved filter are tenant/user configuration.

## Readiness

- Production behavior: implemented and independently reviewed; blocking authorization/concurrency findings were resolved.
- Automated coverage: focused contract and Playwright cases are `Implemented / Not Run`; deeper integration/reconciliation cases remain `Planned` in the batch test plan.
