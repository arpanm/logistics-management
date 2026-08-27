# FIN-02 — Collections and receipts dashboard/register UX

**Status:** Implemented
**Evidence reviewed:** current collection/receipt UI/API, `FEATURES.md`, and collection drill/buckets in `backup/dashboard.html`. No tests were run.

## Problem and outcome

Collections currently exposes a priority queue and basic receipt allocation, but requires complete invoice, receipt, allocation, follow-up and reconciliation registers with contextual forms and exact ledger-derived balances.

## Scope and actors

- Finance landing Collection priority card; `/app/finance/receipts` dashboard with Open invoices, Receipts, Unallocated, Follow-ups/promises and Reconciliation views.
- Create/import-compatible receipt, allocate/deduct/on-account/reconcile/reverse, add follow-up/promise/hold and download SOA actions.
- `finance.read` views scoped ledgers; `finance.admin` records receipts/follow-ups; allocation/reconciliation/reversal capabilities and maker-checker are configurable. No actor sees clients/locations outside effective scope.

## UX behavior

1. KPIs: submitted invoices, billed, received, outstanding, open/part-paid, overdue count/value, unallocated receipts, broken promises and ageing buckets `0–30`, `31–45`, `46–90`, `>90`. Clicks open reconciling rows.
2. Open invoice register mirrors prototype detail: invoice/LR, client/location, submitted/due dates, credit days, days outstanding, billed/received/due, hold/follow-up/promise and risk. Filters/search/sort/page persist in URL.
3. Receipt register includes reference, client, payment date, amount, mode, UTR/instrument, bank, allocated/unallocated, reconciliation state and actions.
4. Create receipt uses calendar date, formatted amount/currency, client/bank search-select, mode-conditioned UTR/instrument fields and evidence upload—no JSON/raw IDs/minor units.
5. Allocation drawer search-selects receipt and eligible invoices, shows current balances, supports multiple lines, deduction reason/evidence and configured on-account handling, previews exact result, then confirms atomically.
6. Follow-up form captures date/time, channel, contact, outcome, promise date/amount, next action, hold/deduction reason, SOA reference, note/evidence. It replaces browser prompts.
7. Detail timelines show append-only receipt/allocation/reversal and invoice follow-up history. Reversal clearly creates compensating entries.
8. Loading, empty, duplicate UTR, over-allocation, stale ledger, validation, permission, partial import and retry states preserve input/context.

## Data and invariants

- Receipt and allocation/deduction/on-account/reversal entries are append-only; displayed received/balance values are derived.
- Exact non-negative amounts use minor units internally. Allocation cannot exceed receipt/invoice position except explicit configured on-account entry.
- UTR/external reference uniqueness is tenant/bank/mode scoped. Closed invoices are excluded from actionable collections but retained in All.
- Ageing uses acknowledged submission date in tenant timezone; Green through 30, Yellow 31–45, Red above 45 for open balances.

## API/events/idempotency

- List/detail endpoints accept client/location/state/risk/date/value/owner/search/sort/page and return allowed actions, pagination and as-of.
- Typed receipt, allocation, reconciliation, reversal and follow-up commands require CSRF, stable idempotency and expected ledger/version where applicable.
- Transaction writes ledger/audit/outbox together (`receipt.recorded/allocated/reconciled/reversed`, `collection.followup/promise/hold-changed`).

## Reports, alerts, recovery

- Dashboard, invoice register, receipt register, SOA, ageing buckets and export reconcile to the same scoped ledger.
- Alerts: open threshold, broken promise, no follow-up, unallocated receipt, duplicate UTR, deduction action and reconciliation failure.
- Duplicate/retry returns original result. Concurrent allocation rechecks balances under lock and returns current position without losing the draft. Downstream SOA delivery failure is retryable.

## Acceptance criteria

- **FIN02-AC01:** Finance/Collections dashboards expose complete pending queues and prototype-equivalent KPIs/buckets; KPI drill rows reconcile exactly.
- **FIN02-AC02:** Open Invoices and All Receipts are complete paginated registers with filters, detail, contextual CTAs and visible export.
- **FIN02-AC03:** Receipt, allocation, deduction/on-account, reconciliation, reversal and follow-up forms use typed controls and searchable references, never prompts/JSON/raw IDs/minor units.
- **FIN02-AC04:** Partial/full/many-to-many allocation and reversal derive exact balances; summaries are not editable and over-allocation is governed.
- **FIN02-AC05:** Duplicate receipt/UTR and retries cannot double post; concurrent changes return recoverable conflict state.
- **FIN02-AC06:** 30/45-day risk, registers, dashboard, SOA and exports reconcile under identical tenant/scope permissions.
- **FIN02-AC07:** Empty/error/retry/stale/responsive/keyboard states are complete and retain filters/forms.

## Assumptions and readiness

On-account, reconciliation maker-checker and follow-up SLA are tenant policy. No blocking decision remains. Production behavior is implemented and independently reviewed, including cross-scope/client allocation guards; focused contract/Playwright cases are `Implemented / Not Run` and deeper ledger cases remain `Planned`.
