# CTL-01 — Full Control Tower prototype parity and actionable drill-down

**Status:** Implemented
**Evidence reviewed:** `FEATURES.md`, current five-lens Control Tower UI/API/service, and all behavior/fields in `backup/dashboard.html`. The prototype is requirements evidence, not production architecture. The UI-01 batch adds responsive desktop/mobile representations, exact actionable KPI predicates, stable bounded server pagination/sorting, URL-backed keyboard tabs, and retained stale/error refresh states. BUG-CTL-026 additionally proves explicit vendor allocation objects with focused contract, PostgreSQL reconciliation, and real-browser checks passing; the broader authored suite remains not run.

## Problem and outcome

The current Control Tower has five tabs, basic cards, filters and flat rows, but misses the prototype’s portfolio-to-client-to-location-to-record reporting, vendor allocation block, ageing buckets and exact operational detail. It must provide permission-scoped canonical metrics, complete drill paths and links to actionable source records without simulated data.

## Scope and dependencies

- `/app/control` lenses: Placement, POD vs Invoice, Collection, Trip, Vendor Payable, enabled by module access/capability.
- Global as-of/freshness, live/pause, search, hierarchy/reference/risk filters, saved views, breadcrumbs and exact visible export.
- Prototype parity for Placement/POD/Collection plus equivalent complete Trip/Vendor Payable lenses.
- Depends on OPS-01/02/03, DOC-01, FIN-01/02/03 and FND-02 scope projection. Control Tower is read/reporting; mutations occur on linked source workbenches.

## Actors, authorization, and projection

- Control/read capability plus source-module capability determines visible tabs, KPIs, rows and fields.
- Tenant, legal entity, region, branch, client, location, vendor and assigned-trip scope is server-derived at every aggregation/drill/export level.
- Commercial values, vendor cost/margin, bank and PII fields require field-level capability. A KPI never reveals a hidden child through counts or totals.

## Global UX and states

1. Tabs are keyboard-operable and URL-addressable. Switching lens resets incompatible drill dimensions but preserves compatible global filters.
2. Controls: as-of, tenant timezone, live/paused 30-second refresh, search, hierarchy/client/location/vendor, status/risk, date, saved view select/save/update/default/delete, reset and Download visible view.
3. Breadcrumbs preserve lens/filter/as-of and allow back navigation. Any KPI/card/table count opens the exact filtered next level; record rows link to their source detail/action page.
4. Live refresh preserves lens, drill level, focus, filters, sort and pagination. Paused state visibly freezes `asOf`; freshness distinguishes LIVE, DELAYED, PARTIAL and FAILED per source.
5. Loading skeletons preserve layout; empty states explain filters/no source data; partial/failed sources identify impact and retry; stale data remains visibly timestamped. Zero denominator renders `0` or `—`, never NaN.
6. Desktop uses cards and scroll-safe tables; small screens use accessible summaries/cards with equivalent fields/actions. Tables support keyboard drill and labelled sort.

## Lens behavior and prototype parity

### Placement

- KPIs: live indents, Green/Yellow/Red, requested, allotted, placed, awaiting/NTP and fill rate.
- Drill: all clients → client locations → indent MIS. Location columns: indents, placed, pending, G/Y/R and fill.
- Detail preserves prototype fields: indent, truck type, vendor, vehicle, driver, commitment/due, actual placement, ageing, risk/status; include vendor allocation cards with allotted/placed/NTP.

### POD vs Invoice

- KPIs: invoices/LRs, POD received, pending current, pending prior, value at risk and closure rate.
- Drill: clients → locations → LR/POD register with LR, invoice/value, vehicle/truck, loaded/delivered/POD dates, pending days and status.
- Value at risk deduplicates invoice value across multiple LR/POD relationships according to canonical policy.

### Collection

- KPIs: submitted invoices, billed, received, due/outstanding, open/part-paid, over-45 count/value and oldest days.
- Includes ageing bucket amount/share for `0–30`, `31–45`, `46–90`, `>90`.
- Drill: clients → locations → invoice register with invoice/LR, submitted, credit days, outstanding days, billed/received/due, hold, last/next follow-up, promise and risk.

### Trip

- KPIs: active, awaiting start, loading, in transit, at destination, at risk/delayed, GPS silent, detention and delivery exceptions.
- Drill: clients/locations or vendor → trip register with trip/LR/indent, vehicle/driver, milestone, ETA/variance, GPS freshness, detention, exception and source-record link.

### Vendor Payable

- KPIs: unbilled services/value, verification/approval pending, due/overdue, payment blocked, disputed, payment-run failed and paid.
- Drill: vendors → status/age bucket → bill/payment register with service/bill, expected/payable/outstanding, variance, bank/compliance block, due/risk and source link.

## Data, calculations, and invariants

- Server queries canonical transaction/ledger data or verified PostgreSQL reporting projections; browser never computes authoritative totals from simulated/partial rows.
- Summary and drill use a shared typed filter/scope contract and one `asOf`. Worst child is Red if any included child is Red, else Yellow if any Yellow, else Green; cancelled/excluded records follow feature policy.
- Money and quantities remain exact. Time boundaries use tenant timezone. Reporting indexes/projections are forward-safe and expose refresh timestamp/source status.
- Saved views are tenant/user/lens scoped, versioned, named uniquely and contain validated filters only.

## API and export

- Existing `GET /control-workbench/:lens` returns `{lens, level, asOf, freshnessBySource, filters, breadcrumbs, kpis, groups/rows, page}` and accepts level/drill IDs/search/filters/sort/page/as-of.
- Detail/count drill is server-computed, not client regrouping. Saved-view CRUD includes update/default/delete with CSRF/version. Export uses identical validated query and permission projection.
- Visible export contains the exact current level/filter/sort/columns, records an audit event and returns an as-of-bearing filename/manifest. Large export may be PostgreSQL-backed async, with visible status/retry.

## Alerts, audit, observability, and failure recovery

- Control Tower consumes canonical risk states; it does not create competing statuses. Source-record CTA routes to the appropriate Operations, POD or Finance workbench.
- Saved-view and export mutations are audited with actor, lens, validated filters, row count, as-of and correlation key. Logs/metrics capture query latency, source freshness and row count without sensitive row payloads.
- If one source fails, affected KPIs show unavailable/partial and unaffected lenses remain usable. Refresh/export retry is safe; stale projection never masquerades as live.

## Acceptance criteria

- **CTL01-AC01:** Placement, POD and Collection reproduce every KPI, three-level drill, detail field, vendor block and ageing bucket evidenced in `backup/dashboard.html`, using canonical data.
- **CTL01-AC02:** Trip and Vendor Payable provide equivalent KPI-to-register drill paths and direct source-record links.
- **CTL01-AC03:** Every KPI/count/amount reconciles exactly to permission-scoped drill rows and an independent canonical/reporting query at the displayed `asOf`.
- **CTL01-AC04:** Search, filters, sort, pagination, saved views, breadcrumbs and visible export remain consistent at every level; refresh never discards state.
- **CTL01-AC05:** Tabs, metrics and fields are module/capability/scope safe; direct URL/API/export cannot disclose hidden tenants, records or values.
- **CTL01-AC06:** Worst-status, 24/48 placement, 7/15 POD and 30/45 collection boundaries follow canonical feature policies with exact empty-denominator behavior.
- **CTL01-AC07:** LIVE/DELAYED/PARTIAL/FAILED freshness is visible per source and failures permit retry without presenting stale data as current.
- **CTL01-AC08:** Responsive and keyboard behavior covers tabs, KPI drill, filters, breadcrumbs, saved views and tables with loading/empty/error/partial states.

## Assumptions and readiness

Default lens, refresh interval, freshness thresholds, included cancelled states and saved-view limits are tenant/user configuration. No blocking product decision remains. Production behavior is implemented and independently reviewed; focused contract/Playwright cases are `Implemented / Not Run`, deeper reconciliation cases remain `Planned`, and no passing test result is claimed.
