# AGENTS.md

These instructions apply to the entire repository. More specific `AGENTS.md` files may be added inside application packages only when their rules do not weaken this contract.

## Mission

Build the reusable logistics platform described in `FEATURES.md` through complete, independently verifiable feature slices. Treat the backup prototypes as requirements evidence, never as production architecture.

## Rapid batch workflow

For implementation requests, use the repo-local `$feature-sdlc` skill in rapid batch mode. The normal unit of delivery is a dependency-compatible batch of related features or TODO fixes, not one agent ceremony and test cycle per feature.

Default roles:

1. `implementation_worker` — owns production code and updates automated tests without running the full suites.
2. `reviewer` — reviews one completed batch for correctness, isolation, security, financial integrity, and obvious gaps.

Use `spec_analyst`, `test_designer`, or `e2e_tester` only when the user explicitly requests them or a batch has material ambiguity or high risk that cannot be handled with lightweight acceptance notes and normal review. Parallelize independent implementation areas with explicit, non-overlapping ownership. Never let agents overwrite or revert another agent's work.

## Batch lifecycle

1. Select the largest sensible dependency-compatible batch from `FEATURES.md` and `TODO.md`; record the included IDs and inspect Git state.
2. Add or update lightweight acceptance notes in existing feature specs. Create a full spec/test plan only for material ambiguity, high-risk authorization/financial behavior, or an explicit user request.
3. Implement the batch end to end: migrations, domain logic, API, authorization, UI, audit/telemetry, affected reports/events, documentation, and automated test cases.
4. Author or update focused unit, integration, contract, security, migration, and Playwright cases as applicable, but mark newly added or changed cases `Implemented / Not Run` until an explicit test phase executes them.
5. Do not automatically run tests, deploy locally, invoke Playwright, run `make check`, or run `make verify` for each feature. Do not enter fix/retest loops unless the user asks.
6. Review the combined batch once. Fix clear code-review blockers together without automatically running tests afterward.
7. Synchronize `FEATURES.md`, `README.md`, `TODO.md`, affected specs, test-case lists, and documentation once for the batch. Implementation and test status must remain distinct.
8. When the user explicitly requests a batch/release test phase, deploy once if needed, run the selected focused suites or full regression once, and record each result as Passing, Failing, or Blocked. Do not automatically fix or rerun failures; add them to the bug/TODO list with evidence unless asked to fix.
9. Before a requested batch commit, run only lightweight non-test gates once: formatting, type checking, and policy/status checks. A single focused batch commit covering related IDs is allowed. Do not push unless explicitly asked.

## Definition of done

A feature may be implementation-complete before its tests have been executed. Keep those facts explicit:

- Acceptance notes identify the intended outcome, dependencies, material rules, and test cases.
- Database migrations are forward-safe by design; execution evidence is recorded only when run.
- Server-side tenant isolation and scoped authorization are implemented and have automated coverage authored.
- UI is accessible, responsive, and handles loading, empty, error, and retry states.
- Domain calculations have exact boundary tests and use exact decimal/timezone-safe handling.
- Relevant reports reconcile with transaction detail.
- Local deployment and Playwright results are not prerequisites for `Implemented`; they are executed only in an explicit batch/release test phase.
- No secrets, backup source artifacts, generated test output, or unrelated changes enter the commit.
- A batch review has no unresolved blocking code finding.
- Feature/test statuses, README summary, TODO queue, specs, and executable test-case status are mutually consistent. `Implemented / Not Run` is valid and must never be reported as Passing.

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
- Use only the shared central PostgreSQL container for local infrastructure. Do not add or start project-specific PostgreSQL, Redis, queue, object-store, Mailpit, or worker containers.

## Code and repository conventions

- Follow the existing stack and patterns. Do not introduce another framework without an accepted ADR.
- Prefer small cohesive modules and typed boundaries. Validate all external input.
- Keep generated clients/artifacts out of manual edits.
- Use `rg` for search. Use non-destructive Git commands. Never reset or discard user changes.
- Use Conventional Commits with a feature or batch scope, for example `feat(MST): complete master-data workflows`.
- One related batch per commit is allowed. Use `fix`, `test`, `docs`, `refactor`, or `chore` when they accurately describe the batch.
- Do not amend, rebase, push, tag, or force-update history unless explicitly requested.
- Never include schedules or delivery estimates in repository documentation.

## Verification commands

These commands are available, but none is automatically required per feature. Run them only when the user requests testing/verification or at an explicitly selected batch/release test phase:

```bash
make policy-check
make postgres-status
make check
make deploy-local
make e2e
make verify
```

For a commit-only batch gate, run formatting, type checking, and policy/status checks once. Do not claim an unexecuted test passed.

## Source hierarchy

1. Current user instruction
2. This `AGENTS.md`
3. Approved batch acceptance notes/spec decisions
4. `FEATURES.md`
5. Architecture/SDLC/testing documentation
6. Backup prototypes and workbook as historical evidence

When sources disagree, document the resolution in the feature spec or an ADR.
