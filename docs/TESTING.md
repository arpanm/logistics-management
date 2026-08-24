# Testing Strategy

## Test layers

| Layer | Purpose | Expected location |
|---|---|---|
| Unit | Pure domain calculations, policies, validators, state transitions, boundary rules | Beside source or package test directory |
| Integration | Database repositories, migrations, transactions, queues, object storage, authorization queries | Package/app integration tests |
| Contract | API schemas, webhooks, imports/exports, provider adapters | Module contract tests |
| Component | Accessible UI behavior without full browser journey | UI/app component tests |
| End to end | Real browser behavior against locally deployed services | `tests/e2e/` |
| Reconciliation | KPI/ledger/report totals against canonical transactions | Domain/report integration and E2E |

## Mandatory domain coverage

- Two-tenant negative-access fixtures for every tenant-owned resource.
- Scoped-role positive and negative cases.
- Exact placement, POD, and collection threshold boundaries.
- Tenant timezone calendar boundaries.
- Decimal/money rounding and reconciliation.
- Duplicate/idempotent retry behavior.
- Concurrent update/version-conflict behavior.
- State-machine valid and invalid transitions.
- Import row/column validation and correction history.
- Ledger posting, partial allocation, full allocation, over-allocation policy, and reversal.

## Playwright conventions

- Test observable behavior, not implementation details.
- Prefer semantic locators: role, label, placeholder, visible text, and test IDs only when no stable accessible locator exists.
- Tests must run independently and in parallel unless explicitly marked serial for a documented shared-resource reason.
- Use deterministic fixture factories with unique tenant and record keys.
- Set up data through supported API/test fixtures; execute the behavior under test through the UI.
- Never use arbitrary sleeps. Wait for UI state, network response, event, or persisted outcome.
- Assert server-side effects for material operations, not only toast messages.
- Include accessibility smoke checks for new primary screens when the chosen library is established.
- Capture trace on first retry and screenshots on failure. Keep generated output out of Git.

## Required E2E scenarios per feature

1. Primary permitted-user success path.
2. Validation failure with no partial mutation.
3. Unauthorized role/scope/tenant path.
4. Material exception or recovery path.
5. Relevant report/dashboard reconciliation or downstream event.

## Local E2E contract

- Base URL comes from `E2E_BASE_URL`, default `http://127.0.0.1:3000`.
- A readiness endpoint must return success before tests begin.
- Test mode uses dedicated database/schema and object prefix.
- E2E data must never point to non-local services without explicit authorization.
- The test runner may reuse an already-running local server; CI can start one through Playwright `webServer` configuration.

## Evidence

`completion.md` records commands and concise results. Do not commit videos, traces, screenshots, database dumps, or HTML reports unless a small artifact is expressly required as permanent documentation.

