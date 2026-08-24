# Project TODO

This is the active execution queue. It is synchronized at the end of every feature with `FEATURES.md`, `README.md`, the feature spec/test plan/completion evidence, and executable tests.

## Active

| Feature | Work item | State | Owner/reason | Evidence or unblock condition |
|---|---|---|---|---|
| FND-02 | Run the preserved 16-case desktop/mobile Playwright suite during consolidated testing | Implemented | Development-first batch; browser execution intentionally deferred | `tests/e2e/fnd-02-identity-access.spec.ts` |
| MST-01..CFG-01 | Implement the remaining feature register using reusable master, workflow, finance, reporting, and configuration modules | In progress | Rapid parallel implementation batch requested by user | `FEATURES.md` feature register |

## Blocked

None.

## Rules

- Remove an item when it is fully completed and reflected in feature completion evidence.
- Keep partial or deferred work with a feature ID, explicit state, owner/reason, and evidence/unblock condition.
- Do not use this file as a substitute for acceptance criteria or the test plan.
- Never leave completed checkboxes, stale test failures, or unowned TODO/FIXME markers after the final feature synchronization gate.
