# Agentic SDLC

## Goal

Turn each feature in `FEATURES.md` into a reviewed, locally deployed, browser-tested, locally committed vertical slice with durable specification and evidence.

## Orchestration model

The primary Codex agent is accountable for the outcome and starts specialized agents defined in `.codex/agents/`. Agents work in ordered phases:

```mermaid
flowchart LR
    S["Select dependency-ready feature"] --> P["Spec analyst + test designer"]
    P --> G["Primary specification gate"]
    G --> I["Implementation worker"]
    I --> C["Unit/integration/type/lint gates"]
    C --> L["Local deploy"]
    L --> E["E2E tester"]
    E --> R["Independent reviewer"]
    R -->|"blocking finding"| I
    R --> V["Final verification"]
    V --> D["Completion evidence + status"]
    D --> M["Focused local Git commit"]
```

Specification and test design can run in parallel because they own separate files. Production implementation is single-owner. Review may run in parallel with read-only analysis, but final verification waits for all agents.

## Phase gates

### 1. Intake

- Select one feature whose dependencies are Complete.
- Read the feature section, product-wide rules, cross-feature journeys, and relevant supplied data dictionary.
- Inspect repository state and record pre-existing changes.
- Create a feature branch when the repository's current workflow uses branches. Do not force branch changes over user work.

### 2. Specification team

- `spec_analyst` creates `specs/<ID>/spec.md`.
- `test_designer` creates `specs/<ID>/test-plan.md`.
- Both trace to acceptance criteria and identify open decisions.
- The primary agent reconciles conflicts and marks the spec Approved for implementation.

### 3. Development

- `implementation_worker` owns production files and implements a complete vertical slice.
- Use small checkpoints, but do not create partial commits unless the user requests them.
- Run focused tests after each material behavior change.

### 4. Local deployment

- Start dependencies with `make infra-up`.
- Apply database migrations and seed deterministic E2E fixtures.
- Build and start the application with `make deploy-local`.
- Verify the health/readiness endpoint and worker health before browser tests.

### 5. End-to-end test

- `e2e_tester` implements Playwright scenarios from the approved test plan.
- Cover primary success, authorization isolation, validation, and at least one material exception.
- Prefer role-authenticated API fixtures for setup and UI for behavior under test.
- Retain trace/screenshot/video for failure diagnosis; generated artifacts remain uncommitted.

### 6. Independent review

- `reviewer` examines the full diff and executed evidence.
- Findings are ordered by correctness, isolation/security, financial integrity, migrations, idempotency, test gaps, accessibility, maintainability.
- Implementation worker fixes blocking findings; affected checks repeat.

### 7. Completion and commit

- Run `make verify` from the final tree.
- Create `specs/<ID>/completion.md` with commands and results.
- Change feature status to Complete only if all acceptance criteria pass.
- Stage only files belonging to the feature.
- Review `git diff --cached` and secret scan output.
- Create a local Conventional Commit; do not push.

## Failure behavior

- A failed gate stops downstream completion and commit.
- Record a real external blocker in the feature spec with evidence and an actionable unblock condition.
- Do not weaken or skip tests to obtain green status.
- If local deployment is unavailable, the feature remains In progress; unit tests alone are insufficient.
- If a flaky test appears, diagnose and remove nondeterminism. Retrying without explanation is not acceptance.

## Feature selection

Use dependency order from `FEATURES.md`. Within the ready set, prefer foundations that unlock more downstream features. Never mark a dependency Complete solely to start another feature.

