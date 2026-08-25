# Logistics Operations Control Tower

A configurable, multi-tenant B2B logistics platform for managing client contracts, truck indents, vendor placement, trips, POD, client billing and collections, vendor payables, alerts, and control-tower reporting.

The product requirements and per-feature implementation/test status are maintained in [FEATURES.md](FEATURES.md). The active execution queue is [TODO.md](TODO.md), and failed-acceptance RCA is maintained in [BUGS.md](BUGS.md). Supplied Juri Gari prototypes and the workbook are preserved in `backup/` as read-only reference material and intentionally excluded from Git.

## Current project status

| Item                              | Status                                                                                                     |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Agentic SDLC scaffold             | Complete                                                                                                   |
| Application bootstrap             | Complete — `FND-01` concurrent report reconciliation is fixed and verified                                 |
| Automated feature tests           | Passing — all non-browser gates and 180/180 desktop/mobile Playwright executions pass                      |
| Local frontend/backend deployment | Healthy on ports 3000/4000 against shared PostgreSQL                                                       |
| Feature implementation            | Complete — all 18 feature areas use the canonical authorized PostgreSQL implementation and pass acceptance |

Agents must update this summary, `FEATURES.md`, `TODO.md`, the relevant feature spec/test plan/completion evidence, and executable test case status at the end of every feature.

The completed implementation includes normalized canonical stores and workflows for masters, operations, POD, finance, governance, configuration, control-tower, alerts, imports, and integrations. All recorded acceptance and gap defects are resolved; final evidence is recorded in `BUGS.md` and `specs/ALL-FEATURE-GAPS/completion.md`.

## Engineering baseline

- TypeScript monorepo managed with `pnpm`
- Next.js frontend in `apps/frontend`
- NestJS backend in `apps/backend`
- PostgreSQL with Prisma migrations
- Vitest for unit/integration tests
- Playwright for browser end-to-end tests
- One central Docker PostgreSQL container shared by this and other local projects

Redis, queues, object storage, Mailpit, and other supporting containers are intentionally excluded. PostgreSQL is the only local infrastructure dependency for now. The decision is documented in [ADR 0001](docs/decisions/0001-application-baseline.md).

## Central PostgreSQL

The project reuses one container named `shared-postgres` and one shared volume. It provisions project-specific roles, databases, and schemas inside that container. Project scripts never stop, reset, or delete the shared container or volume.

```bash
cp .env.example .env
make bootstrap
make postgres-up
```

Default project resources:

- Databases: `logistics`, `logistics_test`
- Schemas in each database: `app`, `audit`, `reporting`
- Application role: `logistics_app`

Other projects may use the same container with their own database/schema names.

## Application commands

```bash
make dev
make check
make deploy-local
make e2e
make verify
```

See [docs/LOCAL_DEVELOPMENT.md](docs/LOCAL_DEVELOPMENT.md) for setup and [docs/SDLC.md](docs/SDLC.md) for the feature workflow.

## Run a feature

Open the repository as a trusted Codex project and invoke:

```text
$feature-sdlc Implement FND-02.
```

The skill starts the required multi-agent team, creates the feature specification and test plan, develops the vertical slice, deploys frontend/backend locally against shared PostgreSQL, runs Playwright, performs independent review, synchronizes all status/test/TODO artifacts, and creates a focused local commit only after the gates pass.

## Commands

| Command                   | Purpose                                                                         |
| ------------------------- | ------------------------------------------------------------------------------- |
| `make bootstrap`          | Validate prerequisites, configure hooks, and install dependencies when present. |
| `make postgres-up`        | Create/start central PostgreSQL and provision this project's databases/schemas. |
| `make postgres-provision` | Add or repair only this project's role, databases, and schemas.                 |
| `make postgres-status`    | Verify the shared container and project database.                               |
| `make dev`                | Start frontend and backend in development mode.                                 |
| `make check`              | Run formatting, linting, type checks, and non-browser tests.                    |
| `make deploy-local`       | Apply migrations, build, and start frontend/backend locally.                    |
| `make e2e`                | Run Playwright against the local frontend/backend.                              |
| `make verify`             | Run final repository and application quality gates.                             |
| `make status`             | Show feature, test, TODO, and Git status.                                       |

## Documentation map

- [AGENTS.md](AGENTS.md) — binding instructions for Codex and subagents
- `.agents/skills/feature-sdlc/SKILL.md` — reusable feature execution workflow
- [FEATURES.md](FEATURES.md) — scope, implementation status, test status, acceptance criteria, and prompts
- [TODO.md](TODO.md) — active execution queue and unresolved work
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — boundaries and engineering invariants
- [docs/SDLC.md](docs/SDLC.md) — specification-to-commit lifecycle
- [docs/TESTING.md](docs/TESTING.md) — test strategy and status conventions
- [docs/API.md](docs/API.md) — current HTTP authentication, tenancy, and route contract
- [docs/LOCAL_DEVELOPMENT.md](docs/LOCAL_DEVELOPMENT.md) — shared PostgreSQL and local deployment
- [CONTRIBUTING.md](CONTRIBUTING.md) — commit and review conventions
- [specs/README.md](specs/README.md) — per-feature artifact layout
