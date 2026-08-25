# <FEATURE-ID> — Test Plan

**Plan status:** Lightweight | Detailed | Executed
**Overall test status:** Planned | Implemented / Not Run | Passing | Failing | Blocked
**Related spec:** `specs/<FEATURE-ID>/spec.md`

## Risks

## Fixtures and environments

Define two tenants, scoped roles, deterministic time, currency/timezone, record factories, integration stubs, and cleanup/isolation.

## Acceptance-to-test matrix

| Test ID | Acceptance/risk | Layer | Preconditions | Action | Expected result | Status | Evidence |
| ------- | --------------- | ----- | ------------- | ------ | --------------- | ------ | -------- |

## Unit tests

## Integration and migration tests

## API/contract and idempotency tests

## Authorization and tenant-isolation tests

## Reconciliation and audit tests

## Playwright journeys

### E2E-<ID>-01 — Primary success

### E2E-<ID>-02 — Validation with no partial mutation

### E2E-<ID>-03 — Unauthorized tenant/role/scope

### E2E-<ID>-04 — Material exception and recovery

### E2E-<ID>-05 — Downstream/report reconciliation

## Accessibility and responsive checks

## Failure injection and recovery

## Commands for an explicit batch/release test phase only

```bash
make check
make deploy-local
make health
make e2e
make verify
```

## Coverage readiness

- [ ] Every acceptance criterion has at least one test ID
- [ ] Boundary and negative cases are explicit
- [ ] Required fixtures are deterministic and tenant-isolated
- [ ] Unexecuted coverage is marked Implemented / Not Run

## Execution synchronization (only after an explicit test phase)

- [ ] Every test ID has a final status and evidence
- [ ] No unexplained skipped/only/quarantined test remains
- [ ] Test file names and IDs match this plan
- [ ] `FEATURES.md`, `README.md`, `TODO.md`, and `completion.md` show the same result
