---
name: feature-sdlc
description: Execute one feature from this logistics repository through a mandatory multi-agent workflow covering specification, test design, implementation, local deployment, Playwright end-to-end testing, independent review, completion evidence, status update, and a focused local Git commit. Use whenever a user asks to build, implement, execute, or complete a feature ID from FEATURES.md. Do not use for read-only questions, feature brainstorming, or documentation-only edits.
---

# Feature SDLC

Execute the requested feature completely. Follow `AGENTS.md`; it is the binding repository contract. Read `docs/SDLC.md` and `docs/TESTING.md` before spawning agents.

## Orchestrate

1. Read the feature in `FEATURES.md`, its dependencies, product-wide rules, cross-feature journeys, and relevant data dictionary.
2. Inspect Git state. Record the starting commit and dirty paths. Preserve unrelated user changes.
3. Confirm the feature is dependency-ready. Do not silently substitute another feature.
4. Create `specs/<FEATURE-ID>/`.
5. Spawn `spec_analyst` and `test_designer` in parallel with separate ownership of `spec.md` and `test-plan.md`. Wait for both.
6. Reconcile the artifacts and require complete acceptance-to-test traceability before approving implementation.
7. Spawn `implementation_worker` with exclusive ownership of production code and non-browser tests. Wait, inspect its diff, and run `make check`. Return exact failures for correction until green.
8. Run `make deploy-local` and `make health`. Do not begin browser acceptance while unhealthy.
9. Spawn `e2e_tester` with ownership limited to Playwright tests and E2E fixtures. Require success, validation, unauthorized tenant/role/scope, exception/recovery, and reconciliation journeys. Send production defects to `implementation_worker`.
10. Spawn `reviewer` for an independent read-only review of the complete diff and evidence. Fix all blocking findings and request a targeted re-review.
11. Run `make verify`. Inspect the final diff, generated files, and secret/policy checks.
12. Create `completion.md` from `.codex/templates/completion.md`. Map every acceptance criterion to passing evidence.
13. Update the feature status in `FEATURES.md` only when every criterion passes.
14. Stage only feature files, review the cached diff, and create one local Conventional Commit with the feature ID as scope. Never push, amend, rebase, or tag unless explicitly asked.
15. Report commit hash, local URL, test results, major decisions, and non-blocking follow-up. Do not provide schedule estimates.

## Enforce ownership

- Run specification and test planning concurrently only because they own separate files.
- Let only `implementation_worker` edit production files during implementation.
- Let only `e2e_tester` edit E2E tests/fixtures during browser testing.
- Keep `reviewer` read-only.
- Keep final integration, status, staging, and commit with the primary agent.
- If concurrency is limited, run roles in waves. Never omit a required role.

## Stop before commit

Stop before status completion or commit when any required gate fails, local deployment is unhealthy, acceptance coverage is incomplete, review has a blocking finding, or unrelated changes cannot be separated safely. Name the evidence, affected criterion, and exact unblock condition. Never weaken tests, isolation, authorization, or financial rules to obtain a passing result.

## Required final evidence

- Approved `spec.md` and executed `test-plan.md`
- Passing unit/integration/contract/security/migration checks as applicable
- Healthy local deployment
- Passing Playwright acceptance journeys
- Independent review with no unresolved blocking finding
- Passing `make verify`
- Accurate `FEATURES.md` status and `completion.md`
- One focused local commit and no push
