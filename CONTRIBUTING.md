# Contributing

## Unit of delivery

The unit of delivery is a coherent dependency-compatible batch of feature IDs and TODO fixes. Each batch has lightweight acceptance notes, production implementation, automated coverage authored, one integrated review, synchronized trackers, and an optional related local commit. Deployment and test execution happen only in an explicitly requested batch/release test phase.

## Before changing code

1. Confirm dependencies for every item in the batch are implemented.
2. Check `git status --short` and identify pre-existing changes.
3. Read `AGENTS.md`, the feature section, relevant ADRs, and existing package-level instructions.
4. Update lightweight acceptance notes and planned automated coverage; create full specs/test plans only when risk or an explicit request warrants them.

## Commit convention

Use Conventional Commits with the feature ID as scope:

```text
feat(OPS-01): add indent lifecycle
fix(FIN-02): prevent duplicate receipt allocation
test(DOC-01): cover POD ageing boundaries
docs(FND-02): clarify scoped role resolution
```

The commit body should state important behavior and migration implications. Related feature/TODO changes may share one batch commit; do not combine unrelated work or push from the workflow.

## Database changes

- Use repository migration tooling; never edit a production-applied migration.
- Include tenant keys, indexes, uniqueness scope, foreign keys, and delete behavior deliberately.
- Test applying all migrations to a clean database and upgrading representative existing data.
- Add rollback/compensation notes to the feature spec when reversal is not automatic.

## API changes

- Validate requests and responses at the boundary.
- Keep an explicit versioning and compatibility strategy for external APIs/webhooks.
- Require idempotency keys for retryable business mutations.
- Do not reveal record existence across authorization boundaries.

## UI changes

- Use semantic HTML and accessible names.
- Support keyboard operation, visible focus, appropriate contrast, and responsive layouts.
- Include loading, empty, validation, authorization, error, retry, and stale-data states.
- Keep tenant/role context visible where confusion could cause a material action.

## Review priorities

Correctness, data isolation, authorization, financial integrity, idempotency, migration safety, auditability, accessibility, and missing end-to-end coverage take precedence over cosmetic preferences.

## Batch status synchronization

Before a requested commit, update all artifacts affected by the batch once:

- `FEATURES.md` register and section implementation/test status
- `README.md` current-status and next-feature summary
- `TODO.md` completed/remaining work
- `specs/<FEATURE-ID>/spec.md`, `test-plan.md`, and `completion.md`
- Executable test cases/fixtures and any TODO/FIXME/skip markers
- Relevant architecture, API, deployment, runbook, and package documentation

The cached diff must include these updates or explicitly prove that an artifact was unaffected. Test status must say `Implemented / Not Run` unless a current explicit test phase produced pass/fail evidence.
