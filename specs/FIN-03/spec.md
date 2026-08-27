# FIN-03 — Vendor payable dashboard/register UX

**Status:** Implemented
**Evidence reviewed:** current vendor bill/payment-run UI/API and `FEATURES.md`. No tests were run.

## Problem and outcome

Vendor services, bills and payment runs are presented as thin queues with prompt-driven actions. Finance needs complete registers and safe contextual workflows from unbilled service through verification, approval, payment, remittance, failure and reversal.

## Scope and authorization

- Finance landing Vendor payable exceptions; `/app/finance/vendor-bills` subviews for Unbilled services, All bills, Approval/Disputes, Payment runs and Vendor ledger.
- Create/edit/submit bill, operational verify, finance approve/reject/dispute, create/approve/submit/mark-paid/fail/reverse payment, and remittance actions.
- Readers see scoped projected data; operational verifier, finance approver and payment actor capabilities are separated. Maker/checker and verified-bank rules are backend enforced. Vendor users see only their own bills/ledger/remittance.

## UX behavior

1. KPIs: unbilled service/value, validation exception, verification/approval pending, approved due, overdue, payment blocked, disputed, payment run pending/failed and paid-period value. Clicking opens matching rows.
2. Complete bill register columns include vendor invoice/date, vendor, service period, trips/LRs, expected/claimed/tax/TDS/deduction/advance/payable/outstanding, variance, state, due/risk, owner and actions.
3. Create bill starts from search-selected eligible trip(s), snapshots vendor/rate/bank context, formats currency and computes totals server-side. Draft edit never asks for JSON, raw IDs or minor units.
4. Validation view presents allocation/trip vs agreed rate vs vendor claim, missing evidence and variance reason. Verify/approve/reject/dispute use structured comment/evidence forms, not prompts.
5. Payment run selects approved bills, shows verified bank snapshot and blocks unverified/changed accounts with explanation. It supports exact partial allocations, approval, bank submission reference, paid/fail and compensating reversal.
6. Detail exposes bill/lines, services, three-way checks, approval/audit, payment allocations, deductions, bank verification version and remittance. Vendor ledger reconciles these entries.
7. Loading, empty, invalid/changed bank, duplicate bill/service, stale approval, segregation denial, partial batch failure and retry states retain context.

## Data and invariants

- Every normal payable line links to a trip and vendor-rate snapshot; standalone adjustment requires capability/approval.
- Vendor invoice uniqueness is configured tenant/vendor scope; a trip/service is payable once except adjustment/reversal.
- GST/TDS/deduction/advance/payment/outstanding use exact minor units and server calculations. Payment ledger and reversals are append-only.
- Payment stores the approved verified bank version. Bank change blocks new payment until reapproval; history is unchanged.

## API/events/idempotency

- List/detail endpoints support vendor/state/risk/date/value/owner/search/sort/page and return allowed actions, totals and as-of.
- Existing bill/payment action routes remain typed; add draft edit, reject, validation detail, ledger/remittance and explicit batch composition endpoints where absent.
- Commands require CSRF, idempotency and expected version; batch returns per-allocation result and is replay safe.
- Audit/outbox commit atomically (`vendor-bill.created/submitted/verified/approved/rejected/disputed`, `payment-run.created/approved/submitted/paid/failed/reversed`).

## Reports, alerts, recovery

- Dashboard, payable ageing, bill register, vendor ledger, payment run, tax/deduction, remittance and contribution-margin queries reconcile.
- Alerts cover missing bill, rate variance, compliance/payment block, approval/due/overdue, bank change, failed payment and dispute.
- Failed bank submission does not delete allocation intent; retry is idempotent. Partial batch result records successes/failures and never marks unpaid bills paid. Reversal reopens outstanding via compensation.

## Acceptance criteria

- **FIN03-AC01:** Vendor payable dashboard and complete registers expose every scope-visible actionable/historical service, bill and payment run with reconciled KPI drill.
- **FIN03-AC02:** Users complete bill, validation, verify/approve/reject/dispute, payment and reversal workflows through typed contextual forms with no prompts/JSON/raw IDs/minor units.
- **FIN03-AC03:** Duplicate vendor invoice and duplicate trip billing are prevented; totals reconcile exactly to lines, deductions, advances, payments and reversals.
- **FIN03-AC04:** Maker-checker and verified-bank snapshot rules are enforced server-side and explained in UI.
- **FIN03-AC05:** Payment run partial failure and replay cannot double pay; paid/reversed entries remain append-only and auditable.
- **FIN03-AC06:** Vendor ledger, remittance, payable ageing, dashboard/export and contribution margin reconcile under consistent scope/field permissions.
- **FIN03-AC07:** Loading/empty/error/retry/conflict/responsive/keyboard states preserve work context.

## Assumptions and readiness

Approval stages, payment due policy and standalone adjustments are configurable. No blocking decision remains. Production behavior is implemented and independently reviewed, including scoped approval actions and sensitive-value masking; focused contract/Playwright cases are `Implemented / Not Run` and deeper reconciliation cases remain `Planned`.
