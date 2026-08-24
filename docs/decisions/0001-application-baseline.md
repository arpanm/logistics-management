# ADR 0001 — Application Baseline

**Status:** Accepted for bootstrap

## Context

The repository begins from detailed requirements without an application stack. The product needs tenant-safe transactional workflows, accessible web and mobile-responsive screens, background jobs, document storage, imports, reporting, and browser end-to-end testing. Local setup must remain straightforward for Codex-driven feature work.

## Decision

Use a TypeScript `pnpm` monorepo with:

- Next.js for web UI and server HTTP/API boundary
- PostgreSQL and Prisma for transactional persistence and migrations
- Redis with a repository-selected queue library for workers, outbox delivery, caching, and job coordination
- S3-compatible storage through a provider-neutral adapter, backed by MinIO locally
- Mailpit locally behind a provider-neutral notification adapter
- Vitest for unit and integration tests
- Playwright for browser end-to-end tests
- Docker Compose for local dependencies

Begin as a modular monolith with separate worker process and clear domain packages. Use a transactional outbox rather than synchronous cross-module/provider coupling.

## Consequences

- One language and type system covers most product code and tests.
- Local infrastructure closely resembles production dependencies without prescribing a production cloud.
- Strong module discipline is required to prevent the modular monolith from becoming a tightly coupled codebase.
- Heavy analytics may later need dedicated projections or a separate analytical store, introduced through another ADR when evidence requires it.

## Change policy

An agent may refine package choices during `FND-01`, but replacing the core framework/database or introducing microservices requires a superseding ADR with migration impact and user approval when materially divergent.

