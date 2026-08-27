# FIN-01 — Invoice dashboard and complete invoice register UX

**Status:** Implemented
**Evidence reviewed:** `FEATURES.md`, current finance workbench/controller/service, and invoice/collection views in `backup/dashboard.html`. No tests were run.

## Problem and outcome

Finance currently has read-only overview snippets and an action queue, but users need a landing dashboard of pending invoice work and a complete All Invoices register with every state-valid CTA. The workflow must remain exact, tenant-scoped and append-only after posting.

## Scope and dependencies

- `/app/finance` pending-work dashboard with actionable unbilled, draft, approval, posting, acknowledgement and exception queues.
- `/app/finance/invoices` complete invoice register and detail, including historical/reversed invoices.
- Create/edit draft, submit, approve/reject, post, acknowledge client submission, reverse/create adjustment, view/download and accounting-export retry actions.
- Depends on DOC-01 eligibility, MST-02 commercial snapshots and FND-02 capabilities/scopes.

## Actors, permissions, and scope

- `finance.read`: scoped KPI, queue, register, detail and export.
- `finance.admin`: draft/edit/submit/acknowledge; approval/posting/reversal/export-retry use separately configurable capabilities and maker-checker policy.
- Margin/rate fields require commercial permission. Counts, selectors, detail, mutations and exports apply identical server-derived tenant/client/location/legal-entity scope.
- Invalid-state and unauthorized CTAs are hidden/disabled with explanation and denied by the API.

## UX behavior and states

1. Landing KPIs: unbilled eligible services/value, draft, pending approval, approved-to-post, posted-unsubmitted, overdue billing exceptions and current-period billed value. A KPI opens the matching queue.
2. Pending Invoice Work is a paginated, filterable table—not a fixed preview—with invoice/service, client/location, period, value, owner, state, ageing/exception and the next valid CTA.
3. Navigation exposes Pending work, All invoices, Collections/Receipts and Vendor payables. All Invoices provides search, state/client/location/date/amount/owner filters, sort, saved URL state, pagination and visible export.
4. Create invoice uses search-select eligible services and charge codes, calendar date, INR default, exact formatted currency/quantity inputs, server-calculated tax/total preview and explicit optional fields. Users never enter raw IDs, JSON or “minor units”.
5. Draft detail supports edit/add/remove lines. Submit validates eligibility; approval/rejection records comment; posting confirms immutable number/lines; acknowledgement captures actual submission date/time, mode, reference and evidence; reverse captures reason and creates a compensating document.
6. Detail shows invoice, service/LR/POD links, line/tax calculation, workflow/audit timeline, acknowledgement, allocations/balance, notes/adjustments, attachments and allowed actions.
7. Loading, empty, validation, eligibility-changed, stale-version, permission, downstream export failure and retry states preserve filters/form data and announce outcomes.

## Data and invariants

- Canonical invoice header, immutable posted lines/taxes, billable-service links, acknowledgement, approval, adjustment/reversal, audit and outbox records remain authoritative.
- Money is integer minor units internally and formatted currency externally. Server computes totals; posted number/lines are immutable.
- A billable service/charge is linked once except explicit adjustment. Due date uses acknowledged submission date plus snapshotted credit days.
- Add only forward-safe scoped indexes/reporting projections needed for register/KPI queries.

## API, events, idempotency

- Extend finance workbench response with filtered pending queues, pagination, `asOf/freshness`, allowed actions and reconciled metrics.
- Provide list/detail endpoints for all invoices; existing create/action routes remain typed. Add draft-edit/reject/adjustment/export-retry endpoints where absent.
- All mutations require CSRF, expected version where applicable and `Idempotency-Key`. Same key/body replays; mismatched body conflicts.
- Write audit and outbox atomically (`invoice.created/submitted/approved/rejected/posted/acknowledged/reversed/export-requested`).

## Reports, alerts, audit, observability, recovery

- Dashboard/register/export reconcile to ledger/detail under the same scope. Alerts cover eligible-unbilled, rejected approval, missing evidence, posted-unsubmitted and export failure.
- Audit stores actor, state change, reason, before/after, snapshot/version and correlation key; restricted commercial data is masked.
- A downstream notification/accounting failure does not unpost an invoice; it remains retryable. Concurrent eligibility/duplicate-billing conflicts preserve the draft for correction.

## Acceptance criteria

- **FIN01-AC01:** Finance landing shows complete actionable pending invoice queues; each KPI and state count opens exactly reconciling rows.
- **FIN01-AC02:** All Invoices lists every scope-visible current/historical invoice with filters, pagination, detail, export and state-valid CTAs.
- **FIN01-AC03:** Authorized users can create/edit draft, submit, approve/reject, post, acknowledge, reverse/adjust and retry export without raw IDs, JSON, prompts or minor-unit inputs.
- **FIN01-AC04:** Exact line/tax totals are server-derived; a service cannot be billed twice; posted lines/number cannot be edited.
- **FIN01-AC05:** Due date derives from acknowledged submission date and snapshotted credit days; acknowledgement requires its configured evidence.
- **FIN01-AC06:** Maker-checker, capability, tenant/scope and field projection rules are identical in UI and API.
- **FIN01-AC07:** Loading, empty, error/retry, validation, stale and responsive/keyboard states preserve context.

## Assumptions and readiness

Approval steps, acknowledgement evidence and numbering are tenant configuration. No blocking decision remains. Production behavior is implemented and independently reviewed; focused contract/Playwright cases are `Implemented / Not Run`, deeper ledger/concurrency cases remain `Planned`, and no passing result is claimed.
