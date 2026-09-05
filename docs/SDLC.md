# Rapid Agentic SDLC

## Goal

Finish coherent groups of logistics features quickly while preserving tenant isolation, authorization, financial integrity, migration safety, and honest delivery status. Implementation and test execution are separate phases.

## Default flow

```mermaid
flowchart LR
    B["Select dependency-compatible batch"] --> N["Lightweight acceptance notes"]
    N --> I["Parallel implementation with non-overlapping ownership"]
    I --> T["Author/update automated tests: Not Run"]
    T --> R["Risk-based self or independent review"]
    R --> S["Synchronize affected trackers/docs once"]
    S -. "runtime changed + local services running" .-> L["Refresh local artifacts once"]
    S --> H["Handoff"]
    L --> H
    H -. "commit requested" .-> G["One lightweight commit gate"]
    G --> C["Batch commit"]
    C -. "explicit request only" .-> X["Deploy/test once; record pass/fail"]
```

The primary agent handles small/localized work directly. Add implementation workers only when parallel, non-overlapping ownership will materially reduce elapsed time. Add a reviewer only when the standard or mandatory risk tier applies. Add a specification analyst, test designer, or E2E tester only for an explicit request or material unresolved risk.

## Review tiers

| Tier      | Use when                                                                                                                                                     | Review action                                                                                              |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Fast path | Localized and reversible UI composition, copy, CSS, documentation, configuration wiring, or mechanical changes with no protected invariant impact            | Primary agent checks the focused diff, call sites, formatting, and obvious regressions. No reviewer agent. |
| Standard  | Substantial shared UI/domain behavior, cross-module contracts, or a batch whose interactions are not obvious from one focused diff                           | One bounded reviewer pass over named files and risks; request blocking/high findings only.                 |
| Mandatory | Tenant isolation, authorization policy, financial posting/calculation, migrations or destructive data changes, credentials/secrets, or external side effects | One independent reviewer pass focused on the affected invariant and coverage.                              |

Review tier is determined by impact, not line count. Keep review after the combined implementation, do not review every small edit, and do not repeat full reviews after each correction. One short confirmation is sufficient when a reviewer’s material blocker is fixed.

## Implementation batch

1. Choose the largest coherent batch allowed by dependencies and the user's scope.
2. Inspect the working tree and list included feature/TODO IDs.
3. Record compact acceptance notes: outcome, critical rules, dependencies, affected interfaces, and planned automated tests. Reuse existing specs instead of creating ceremony-only documents.
4. Implement migrations, backend, frontend, authorization, audit, affected reporting/events, documentation, and automated tests together.
5. Do not run tests, Playwright, or `make check`/`make verify` automatically per feature. Mark changed tests `Implemented / Not Run`. When runtime code changed and repository-owned local services are already running in production-style mode, run `make refresh-local` once after the batch so migrations and all package/app artifacts are rebuilt and restarted without reseeding. Documentation, process, agent-instruction, and test-only changes do not require a runtime refresh. `make dev` remains the hot-reload alternative.
6. Apply the review tier once to the integrated batch. Resolve clear blockers together without automatically testing or repeating a full review after each fix.
7. Synchronize only materially affected trackers, specs, test-case lists, and documentation once. Avoid status-file churn when their recorded truth did not change.
8. When a commit is requested, run formatting, type checking, and policy/status checks once for the batch; inspect the cached diff and create one related Conventional Commit.

## Test status

- `Implemented / Not Run` means the production behavior and executable coverage exist, but no current execution result is claimed.
- `Passing`, `Failing`, and `Blocked` require current command evidence from an explicit test phase.
- Historical results may remain documented with their date/build, but they do not convert new or changed coverage to Passing.

## Explicit batch/release test phase

Enter this phase only when the user explicitly asks for testing, regression, deployment verification, or release verification.

1. Run either the requested focused suites or the full regression—not both by default.
2. Deploy once if the selected tests require running services. Use the shared PostgreSQL container and project databases/schemas only.
3. Run each selected suite once. Do not retry automatically.
4. Record pass/fail/block status and concise evidence across the affected trackers.
5. Add failures to `BUGS.md` or `TODO.md` with observed behavior and evidence. Do not auto-fix or rerun unless requested.

## Completion states

- **In progress:** production work is incomplete.
- **Implemented:** requested production behavior and test coverage are present; tests may be Not Run.
- **Verified:** the explicitly selected test scope passed for the recorded build.

A feature can be implementation-complete while tests are Not Run. It must not be labeled Passing or Verified without execution evidence.

## Failure behavior

- A code-review blocker prevents implementation completion until resolved.
- A test failure in an explicit test phase is recorded once and does not trigger an automatic fix/retest loop.
- Never weaken isolation, authorization, financial rules, migrations, or tests to obtain green status.
- Never report an unexecuted test, deployment, or regression as successful.
