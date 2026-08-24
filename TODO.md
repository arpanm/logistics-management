# Project TODO

This is the active execution queue. It is synchronized at the end of every feature with `FEATURES.md`, `README.md`, the feature spec/test plan/completion evidence, and executable tests.

## Active

| Feature | Work item | State | Owner/reason | Evidence or unblock condition |
|---|---|---|---|---|
| FND-02 | Run the preserved 16-case desktop/mobile Playwright suite | Implemented | Non-browser gates pass; full feature-specific browser execution remains | `tests/e2e/fnd-02-identity-access.spec.ts` |
| MST-01..CFG-01 | Expand the passing rapid smoke into feature-specific acceptance suites | Implemented | Desktop/mobile cross-feature smoke passes 2/2 | `tests/e2e/rapid-all-features.spec.ts` |

## Blocked

None.

## Rules

- Remove an item when it is fully completed and reflected in feature completion evidence.
- Keep partial or deferred work with a feature ID, explicit state, owner/reason, and evidence/unblock condition.
- Do not use this file as a substitute for acceptance criteria or the test plan.
- Never leave completed checkboxes, stale test failures, or unowned TODO/FIXME markers after the final feature synchronization gate.
