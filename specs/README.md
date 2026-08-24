# Feature Specifications

Each implemented feature owns a directory named by the exact feature ID:

```text
specs/FND-01/
  spec.md
  test-plan.md
  completion.md
```

Use the templates in `.codex/templates/`. Specifications are durable product/engineering artifacts and are committed with the feature. Generated reports, traces, screenshots, logs, and temporary working notes are not committed.

`spec.md` must be Approved before production implementation begins. `completion.md` must map every acceptance criterion to passing test evidence before the feature status becomes Complete.

