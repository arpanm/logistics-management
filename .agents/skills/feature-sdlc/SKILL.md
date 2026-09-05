---
name: feature-sdlc
description: Implement related logistics features and TODO fixes in rapid batches with lightweight acceptance notes, production implementation, automated tests authored but not automatically run, risk-based review, synchronized trackers, and an optional focused batch commit. Use for feature implementation; run deployment or tests only when explicitly requested as a batch/release phase.
---

# Rapid Feature SDLC

Follow `AGENTS.md`, `docs/SDLC.md`, and `docs/TESTING.md`. Optimize for finishing dependency-compatible work in a small number of implementation batches. Never turn each feature into a separate deploy/test/review loop unless the user explicitly requests that process.

## Execute a batch

1. Read `FEATURES.md` and `TODO.md`; choose the largest coherent dependency-compatible batch that matches the request.
2. Inspect Git state and preserve unrelated changes. Assign explicit, non-overlapping production ownership when parallel workers are useful.
3. Capture lightweight acceptance notes in existing specs or a compact batch note. Require full `spec.md` and `test-plan.md` only for material ambiguity/high-risk behavior or an explicit request.
4. Implement small/localized batches directly. Use one or more `implementation_worker` agents only when independent areas can run in parallel with clear non-overlapping ownership and delegation will materially reduce elapsed time. Tests are authored or updated but are not automatically run.
5. Mark unexecuted test cases `Implemented / Not Run`. Never infer Passing from code review, compilation, an old result, or another test.
6. Choose review by risk:
   - **Fast path:** for localized/reversible UI composition, copy, styling, documentation, or narrowly mechanical code changes with no security, financial, migration, destructive-data, secret, external-side-effect, or shared-contract risk, perform a concise self-review of the changed diff. Do not spawn a reviewer.
   - **Standard:** for substantial or cross-module behavior, use one reviewer with a narrow file/risk scope and request blocking/high findings only.
   - **Mandatory:** use one reviewer for tenant isolation, authorization decisions, financial integrity, migrations/destructive data behavior, secrets/credentials, external side effects, or other high-impact invariants.
7. After the selected review, fix clear blockers together. Do not start repeated review cycles; request at most one concise confirmation when a material reviewer blocker was corrected.
8. Synchronize only materially affected trackers, specs, test-case files, and documentation once. Avoid status-file churn for internal/mechanical changes that do not alter their truth.
9. If runtime code changed and repository-owned local frontend/backend services are already running, run `make refresh-local` once before handoff. It applies migrations, builds every shared package and both apps, restarts only owned processes, preserves tenant data, and verifies readiness. Documentation, agent-instruction, and test-only batches do not require a runtime refresh. If the user is using `make dev`, rely on its hot reload instead.
10. If the user asks to commit, run the lightweight batch gate once: formatting, type checking, policy/status synchronization, and cached-diff review. One related batch commit is allowed. Do not push unless explicitly asked.

## Optional specialist roles

Use `spec_analyst`, `test_designer`, or `e2e_tester` only when explicitly requested or when unresolved material risk warrants the extra role. Specialists do not create an automatic requirement to run any test suite.

## Explicit batch/release test phase

Only enter this phase when the user explicitly requests testing, regression, deployment verification, or release verification:

1. Derive from the request whether the scope is focused tests or full regression.
2. Deploy locally once when browser/integration testing needs it, using the shared central PostgreSQL container.
3. Run the selected suites once. Do not automatically retry.
4. Record exact results as Passing, Failing, or Blocked in the trackers and test-case lists.
5. For failures, add concise evidence/RCA to the bug or TODO list. Do not fix or rerun unless the user asks.

## Ownership and safety

- Multiple workers may run in parallel only with non-overlapping file/module ownership.
- Keep financial, authorization, tenant-isolation, idempotency, migration, and secret-handling invariants intact.
- Use only the shared central PostgreSQL container; add no per-project database or auxiliary infrastructure container.
- Keep generated reports and bulky artifacts out of Git.
- Never claim deployment health, test Passing, or regression Passing without current execution evidence.

## Handoff evidence

- Batch IDs and implemented behavior
- Files/modules owned by each worker
- Test cases added or changed, normally `Implemented / Not Run`
- Selected review tier plus findings/disposition
- Tracker/documentation synchronization
- Lightweight gate results when a commit was requested
- Commit hash when committed, plus an explicit statement that tests were not run unless an explicit test phase occurred
