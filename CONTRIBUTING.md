# Contributing

## Unit of delivery

The unit of delivery is one feature ID from `FEATURES.md`. Each feature has a specification, test plan, implementation, local deployment evidence, Playwright coverage, independent review, and local commit.

## Before changing code

1. Confirm dependencies in the feature register are Complete.
2. Check `git status --short` and identify pre-existing changes.
3. Read `AGENTS.md`, the feature section, relevant ADRs, and existing package-level instructions.
4. Create or update `specs/<FEATURE-ID>/spec.md` and `test-plan.md`.

## Commit convention

Use Conventional Commits with the feature ID as scope:

```text
feat(OPS-01): add indent lifecycle
fix(FIN-02): prevent duplicate receipt allocation
test(DOC-01): cover POD ageing boundaries
docs(FND-02): clarify scoped role resolution
```

The commit body should state important behavior and migration implications. Do not combine unrelated changes. Do not push from the feature workflow.

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

