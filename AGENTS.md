# AGENTS.md

These instructions apply to the entire repository. More specific `AGENTS.md` files may be added inside application packages only when their rules do not weaken this contract.

## Mission

Build the reusable logistics platform described in `FEATURES.md` through complete, independently verifiable feature slices. Treat the backup prototypes as requirements evidence, never as production architecture.

## Mandatory multi-agent workflow

For every feature implementation request, the primary agent must use the repo-local `$feature-sdlc` skill and its multi-agent team workflow.

Required roles:

1. `spec_analyst` — turns the feature into an implementable specification and resolves traceability.
2. `test_designer` — writes the test plan and acceptance-to-test matrix.
3. `implementation_worker` — owns production implementation for the feature.
4. `e2e_tester` — owns Playwright scenarios, local browser verification, and evidence.
5. `reviewer` — independently checks correctness, security, architecture, migrations, and test gaps.

The primary agent orchestrates, makes final decisions, integrates results, runs final gates, updates status, and commits. If concurrency is limited, run roles in ordered waves. Never omit a role; reuse an idle agent with a follow-up task if needed.

Parallelize read-heavy specification, exploration, and review work. Do not let multiple agents edit overlapping production files concurrently. The implementation worker has exclusive write ownership of production code during implementation. The e2e tester may edit only tests and test fixtures after production implementation is stable.

## Feature lifecycle

1. Select exactly one dependency-ready feature from `FEATURES.md`.
2. Verify Git state. Preserve pre-existing user changes and never include unrelated changes in the feature commit.
3. Create `specs/<FEATURE-ID>/spec.md` from `.codex/templates/feature-spec.md`.
4. Create `specs/<FEATURE-ID>/test-plan.md` from `.codex/templates/test-plan.md`.
5. Record open decisions in the spec. Make safe configurable assumptions; stop only for a genuinely blocking product decision.
6. Implement a full vertical slice: schema/migration, domain logic, API, authorization, UI, audit/telemetry, reports/alerts/events where applicable, documentation, and tests.
7. Run unit, integration, contract, security/authorization, and migration checks.
8. Deploy locally using `make deploy-local` and verify health.
9. Run Playwright end to end using `make e2e`. Capture traces/screenshots only for failures or required evidence; do not commit bulky generated output.
10. Run `make verify` and an independent reviewer pass. Fix all blocking findings and repeat affected gates.
11. Update the feature status in `FEATURES.md` only when every acceptance criterion passes. Record completion evidence in `specs/<FEATURE-ID>/completion.md` using the template.
12. Create one focused local Git commit using the approved convention. Do not push unless the user explicitly asks.

## Definition of done

A feature is not done because code exists. It is done only when:

- Feature spec and test plan are complete and trace every acceptance criterion.
- Database migrations are forward-safe and verified from a clean database.
- Server-side tenant isolation and scoped authorization are tested.
- UI is accessible, responsive, and handles loading, empty, error, and retry states.
- Domain calculations have exact boundary tests and use exact decimal/timezone-safe handling.
- Relevant reports reconcile with transaction detail.
- Local deployment succeeds from documented commands.
- Playwright proves the primary happy path, permissions, validation, and a material exception path.
- No secrets, backup source artifacts, generated test output, or unrelated changes enter the commit.
- `make verify` passes and reviewer has no unresolved blocking finding.

## Architecture invariants

- Every business record is tenant-scoped. Tenant context is server-derived; never trust a client-supplied tenant identifier by itself.
- Authorization is enforced at service/query boundaries, not only in UI.
- Financial and quantity values use exact decimal or integer minor units, never binary floating point.
- Store timestamps in UTC; apply tenant timezone for display and calendar/business rules.
- Financial posting and external-event ingestion are idempotent and append-only where auditability matters.
- Posted financial records are reversed with compensating entries, not edited or deleted.
- Master data is effective-dated or snapshotted when historical reproducibility requires it.
- Status colours and totals are computed from canonical events, never user-uploaded summaries.
- Secrets stay in environment/secret stores and must never be logged or committed.
- Avoid customer-specific forks and hard-coded Juri Gari constants; use tenant configuration.

## Code and repository conventions

- Follow the existing stack and patterns. Do not introduce another framework without an accepted ADR.
- Prefer small cohesive modules and typed boundaries. Validate all external input.
- Keep generated clients/artifacts out of manual edits.
- Use `rg` for search. Use non-destructive Git commands. Never reset or discard user changes.
- Use Conventional Commits with feature scope: `feat(FND-01): establish tenant foundation`.
- One feature per commit. Use `fix`, `test`, `docs`, `refactor`, or `chore` only when they accurately describe a standalone non-feature change.
- Do not amend, rebase, push, tag, or force-update history unless explicitly requested.
- Never include schedules or delivery estimates in repository documentation.

## Required verification commands

Prefer repository commands over ad hoc equivalents:

```bash
make policy-check
make check
make deploy-local
make e2e
make verify
```

If a command does not yet apply during bootstrap, implement the missing package/script as part of `FND-01`; do not silently claim the gate passed.

## Source hierarchy

1. Current user instruction
2. This `AGENTS.md`
3. Approved per-feature spec and decisions
4. `FEATURES.md`
5. Architecture/SDLC/testing documentation
6. Backup prototypes and workbook as historical evidence

When sources disagree, document the resolution in the feature spec or an ADR.
