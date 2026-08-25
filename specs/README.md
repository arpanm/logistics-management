# Feature Specifications

High-risk or materially ambiguous features may own a directory named by the exact feature ID:

```text
specs/FND-01/
  spec.md
  test-plan.md
  completion.md
```

Use the templates in `.codex/templates/` when a full artifact set is warranted. Most rapid batches update lightweight acceptance notes in existing specs instead of creating ceremony-only files. Durable product/engineering artifacts are committed with their batch; generated reports, traces, screenshots, logs, and temporary working notes are not committed.

Acceptance notes must identify the outcome, material rules, dependencies, and planned coverage before implementation. Test cases use Planned, Implemented / Not Run, Passing, Failing, Blocked, or justified N/A. Implementation may become Complete while tests remain Implemented / Not Run; only current execution evidence can set Passing or Verified.

Batch synchronization updates `FEATURES.md`, `README.md`, `TODO.md`, executable tests/fixtures, and affected documentation once. Test deployment/execution occurs only in an explicitly requested batch/release phase and is never an automatic per-feature gate.

Cross-feature executable Playwright cases and their latest evidence are tracked in `ALL-FEATURES-E2E-STATUS.md`.
