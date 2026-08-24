# Logistics Operations Control Tower

A configurable, multi-tenant B2B logistics platform for managing client contracts, truck indents, vendor placement, trips, POD, client billing and collections, vendor payables, alerts, and control-tower reporting.

The product requirements are maintained in [FEATURES.md](FEATURES.md). The supplied Juri Gari prototypes and workbook are preserved in `backup/` as read-only reference material and are intentionally excluded from Git.

## Repository state

This repository currently contains the product specification and the agentic SDLC scaffold. Application code is created feature-by-feature. `FND-01` is the bootstrap feature that establishes the executable application baseline.

## Chosen engineering baseline

- TypeScript monorepo managed with `pnpm`
- Next.js web application and API boundary
- PostgreSQL with Prisma migrations
- Redis for queues, caching, and idempotent jobs
- S3-compatible object storage; MinIO locally
- Mailpit locally for email inspection
- Vitest for unit/integration tests
- Playwright for browser end-to-end tests
- Docker Compose for local infrastructure

The decision and permitted alternatives are documented in [docs/decisions/0001-application-baseline.md](docs/decisions/0001-application-baseline.md).

## Start here

Prerequisites: Git, Node.js 22+, Corepack/pnpm, and Docker with Compose.

```bash
make bootstrap
make infra-up
```

After `FND-01` creates the application packages:

```bash
make dev
make verify
make e2e
```

See [docs/LOCAL_DEVELOPMENT.md](docs/LOCAL_DEVELOPMENT.md) for environment setup and [docs/SDLC.md](docs/SDLC.md) for the feature execution workflow.

## Run the agentic feature workflow

Open the repository as a trusted Codex project, then invoke the repo-local skill:

```text
$feature-sdlc Implement FND-01.
```

Repeat with the next dependency-ready feature from `FEATURES.md`. Execute one feature per primary workflow unless the feature register explicitly says a pair is inseparable.

## Important commands

| Command | Purpose |
|---|---|
| `make bootstrap` | Validate prerequisites, install dependencies when present, and configure hooks. |
| `make infra-up` | Start PostgreSQL, Redis, MinIO, and Mailpit. |
| `make infra-down` | Stop local infrastructure without deleting volumes. |
| `make dev` | Start the application in development mode. |
| `make check` | Run formatting, linting, type checks, and non-browser tests. |
| `make deploy-local` | Start infrastructure, apply migrations, and build/start the local application. |
| `make e2e` | Run Playwright against the configured local base URL. |
| `make verify` | Run repository policy and application quality gates. |

## Documentation map

- [AGENTS.md](AGENTS.md) — binding instructions for Codex and subagents
- `.agents/skills/feature-sdlc/SKILL.md` — reusable feature execution workflow
- [FEATURES.md](FEATURES.md) — product scope, status, acceptance criteria, and feature prompts
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — system boundaries and engineering invariants
- [docs/SDLC.md](docs/SDLC.md) — specification-to-commit lifecycle
- [docs/TESTING.md](docs/TESTING.md) — test strategy and Playwright expectations
- [docs/LOCAL_DEVELOPMENT.md](docs/LOCAL_DEVELOPMENT.md) — local deployment and troubleshooting
- [CONTRIBUTING.md](CONTRIBUTING.md) — branch, commit, and review conventions
- [specs/README.md](specs/README.md) — per-feature artifact layout
