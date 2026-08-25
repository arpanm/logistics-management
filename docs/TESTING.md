# Testing Strategy

## Execution policy

Automated tests are designed and maintained with the implementation, but they are not automatically executed for every feature. Newly added or changed coverage remains `Implemented / Not Run` until the user explicitly requests a focused batch test, full regression, deployment verification, or release verification.

When a test phase is requested, run the selected scope once and record the result. Do not automatically retry, fix, or rerun failures.

## Test layers

| Layer          | Purpose                                                                  | Expected location                 |
| -------------- | ------------------------------------------------------------------------ | --------------------------------- |
| Unit           | Pure calculations, policies, validators, transitions, boundaries         | Beside source or package tests    |
| Integration    | PostgreSQL repositories, migrations, transactions, authorization queries | Package/app integration tests     |
| Contract       | API schemas, webhooks, imports/exports, adapters                         | Module contract tests             |
| Component      | Accessible UI behavior without a full browser journey                    | UI/app component tests            |
| End to end     | Real browser behavior against locally deployed services                  | `tests/e2e/`                      |
| Reconciliation | KPI/ledger/report totals against canonical transactions                  | Domain/report integration and E2E |

## Test status vocabulary

| Status                | Meaning                                                                                             |
| --------------------- | --------------------------------------------------------------------------------------------------- |
| Planned               | Coverage is identified but not executable yet.                                                      |
| Implemented / Not Run | Executable coverage exists or was changed, but has not run in the current batch/release test phase. |
| Passing               | The test ran and passed against the recorded build/environment.                                     |
| Failing               | The test ran once and failed; include concise evidence.                                             |
| Blocked               | The test could not run because of a named blocker and unblock condition.                            |
| N/A                   | The requirement is demonstrably not applicable; include justification.                              |

Tracker, spec, and executable test-case status must agree. Never use Passing for an unexecuted case.

## Coverage expectations

Author applicable coverage for:

- two-tenant negative access and scoped-role positive/negative behavior;
- time, timezone, decimal/money, threshold, and state-transition boundaries;
- duplicate/idempotent requests and concurrent/version conflicts;
- import validation and correction history;
- ledger posting, allocation, reconciliation, and compensating reversal;
- primary UI success, validation/no partial mutation, authorization, material exception/recovery, and downstream reconciliation.

These expectations govern test design; they do not cause automatic execution.

## Playwright conventions

- Test observable behavior using real frontend, backend, and PostgreSQL services; do not mock business APIs.
- Prefer semantic locators and deterministic tenant-isolated fixtures.
- Use supported APIs/fixtures for setup and the UI for behavior under test.
- Never use arbitrary sleeps; wait for observable state or persisted outcomes.
- Assert server-side effects for material operations.
- Keep traces, screenshots, videos, and generated reports out of Git.

## Explicit test-phase commands

Choose the smallest requested scope:

```bash
# Focused case or feature
pnpm exec playwright test tests/e2e/<feature>.spec.ts --project=chromium

# Non-browser batch tests
make test

# Full local release regression (only when explicitly requested)
make deploy-local
make e2e
make verify
```

Use only local services and the project test database. Never point Playwright at production. Run the chosen scope once, record pass/fail, and stop unless the user asks for fixes or another run.

## Evidence

Record the command, build/commit, environment, counts, and concise failures in the affected tracker/spec or completion note. A test result without current execution evidence remains `Implemented / Not Run`.
