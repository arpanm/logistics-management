# ADR 0001 — Frontend, Backend, and PostgreSQL Baseline

**Status:** Accepted

## Context

The repository begins from detailed requirements without application code. Local development must be resource-conscious while supporting multi-tenant transactional workflows, browser testing, and independent frontend/backend deployment. The workstation also hosts other projects.

## Decision

Use a TypeScript `pnpm` monorepo with:

- Next.js frontend in `apps/frontend`
- NestJS backend in `apps/backend`
- PostgreSQL and Prisma for transactional persistence, migrations, audit, reporting projections, idempotency, and current-phase scheduled/background coordination
- Vitest for unit/integration tests
- Playwright for browser end-to-end tests
- One central Docker PostgreSQL container shared across local projects

This repository provisions only its role, databases, and schemas inside the central container. It does not own the shared container lifecycle beyond safe create/start and project provisioning.

No Redis, external queue, object-store container, Mailpit, or separate worker deployment is included. When a current feature needs document bytes, event delivery state, leases, or job state, store them in PostgreSQL behind interfaces that allow a later infrastructure change.

## Consequences

- Local resource consumption remains small and predictable.
- Frontend and backend have explicit deployment and API boundaries.
- PostgreSQL becomes the current coordination and persistence system, so queries, locks, retention, and table growth must be designed carefully.
- Project scripts must never stop or delete central PostgreSQL because other projects may depend on it.
- Any new infrastructure component requires a superseding ADR and explicit user approval.

## Change policy

Agents may refine package-level libraries during `FND-01`, but replacing Next.js, NestJS, PostgreSQL, the shared-container policy, or adding infrastructure requires a superseding ADR and user authorization.
