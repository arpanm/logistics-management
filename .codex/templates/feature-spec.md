# <FEATURE-ID> — <Feature name>

**Status:** Draft | Approved | Implemented | Verified
**Feature source:** `FEATURES.md` section
**Owner:** Primary agent

## Problem and outcome

## In scope

## Out of scope

## Dependencies and assumptions

| Item | State/decision | Evidence |
|---|---|---|

The current infrastructure boundary is Next.js frontend, NestJS backend, and the shared central PostgreSQL container only. Record an approved ADR/user authorization before introducing anything else.

## Actors, permissions, and scopes

| Actor/capability | Allowed scope | Sensitive fields/actions | Denied behavior |
|---|---|---|---|

## UX flow

### Primary flow

### Validation, loading, empty, error, retry, and stale states

### Responsive and accessibility behavior

## Data model and migration

### Entities and relationships

### Invariants, indexes, and tenant isolation

### Migration/backfill and reversal plan

## Domain rules and calculations

Include exact boundary semantics, timezone, decimal precision, state transitions, idempotency, concurrency, and historical snapshot behavior.

## API, events, and jobs

| Interface/event/job | Input | Output/effect | Auth/idempotency/failure behavior |
|---|---|---|---|

## Reports and alerts

Define formulas, drill-down/detail reconciliation, freshness, recipients, deduplication, escalation, and resolution.

## Audit, observability, and security

## Acceptance traceability

| Acceptance criterion | Design section | Planned test IDs |
|---|---|---|

## Open decisions

Record owner, safe default, and material impact. An empty table means no unresolved decision.

| Decision | Safe default | Owner/impact |
|---|---|---|

## Approval

- [ ] Spec analyst complete
- [ ] Test designer cross-check complete
- [ ] Primary agent approved for implementation
