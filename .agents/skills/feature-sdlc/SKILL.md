---
name: feature-sdlc
description: Implement related logistics features and TODO fixes in rapid batches with lightweight acceptance notes, production implementation, automated tests authored but not automatically run, one batch review, synchronized trackers, and an optional focused batch commit. Use for feature implementation; run deployment or tests only when explicitly requested as a batch/release phase.
---

# Rapid Feature SDLC

Follow `AGENTS.md`, `docs/SDLC.md`, and `docs/TESTING.md`. Optimize for finishing dependency-compatible work in a small number of implementation batches. Never turn each feature into a separate deploy/test/review loop unless the user explicitly requests that process.

## Execute a batch

1. Read `FEATURES.md` and `TODO.md`; choose the largest coherent dependency-compatible batch that matches the request.
2. Inspect Git state and preserve unrelated changes. Assign explicit, non-overlapping production ownership when parallel workers are useful.
3. Capture lightweight acceptance notes in existing specs or a compact batch note. Require full `spec.md` and `test-plan.md` only for material ambiguity/high-risk behavior or an explicit request.
4. Use one or more `implementation_worker` agents to implement independent areas. Each worker owns production code and related automated tests in its assigned area. Tests are authored or updated but are not automatically run.
5. Mark unexecuted test cases `Implemented / Not Run`. Never infer Passing from code review, compilation, an old result, or another test.
6. Use one `reviewer` for the integrated batch. Fix clear blocking findings together. Do not automatically run tests or enter a test/fix/retest loop.
7. Synchronize `FEATURES.md`, `README.md`, `TODO.md`, affected specs, test-case files, and documentation once for the batch.
8. If the user asks to commit, run the lightweight batch gate once: formatting, type checking, policy/status synchronization, and cached-diff review. One related batch commit is allowed. Do not push unless explicitly asked.

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
- Batch-review findings and disposition
- Tracker/documentation synchronization
- Lightweight gate results when a commit was requested
- Commit hash when committed, plus an explicit statement that tests were not run unless an explicit test phase occurred
