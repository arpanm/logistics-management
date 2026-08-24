# Feature Specifications

Each implemented feature owns a directory named by the exact feature ID:

```text
specs/FND-01/
  spec.md
  test-plan.md
  completion.md
```

Use the templates in `.codex/templates/`. Specifications are durable product/engineering artifacts and are committed with the feature. Generated reports, traces, screenshots, logs, and temporary working notes are not committed.

`spec.md` must be Approved before production implementation begins. The test plan tracks every test ID through Planned, Implemented, Passing, Failing, Blocked, or justified N/A. `completion.md` must map every acceptance criterion to passing test evidence before implementation becomes Complete and test status becomes Passing.

The final feature gate also synchronizes `FEATURES.md`, `README.md`, `TODO.md`, executable tests/fixtures, and affected documentation. Status drift is a failed completion gate.

Cross-feature executable Playwright cases and their latest evidence are tracked in `ALL-FEATURES-E2E-STATUS.md`.
