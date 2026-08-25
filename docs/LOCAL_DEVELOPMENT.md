# Local Development and Deployment

## Runtime components

- Central shared PostgreSQL Docker container on `127.0.0.1:5432`
- Frontend on `127.0.0.1:3000`
- Backend on `127.0.0.1:4000`

No other local infrastructure containers are required.

## Central PostgreSQL ownership

`shared-postgres` and volume `shared-postgres-data` are reusable workstation resources. This repository may create or start them and provision its own resources. It must not stop, reset, or delete them.

Project defaults:

| Resource             | Value                       |
| -------------------- | --------------------------- |
| Application database | `logistics`                 |
| Test database        | `logistics_test`            |
| Application role     | `logistics_app`             |
| Schemas              | `app`, `audit`, `reporting` |

Configure different names in `.env` if they conflict with an existing project. Use lowercase PostgreSQL-safe identifiers.

## Setup

Install Node.js 22 LTS and pnpm 11 first. On macOS:

```bash
brew install node@22 pnpm
```

The commit hook resolves either a standalone `pnpm` or `corepack pnpm`, and includes standard Homebrew paths when Git supplies a reduced environment.

```bash
cp .env.example .env
make bootstrap
make postgres-up
make postgres-status
```

`postgres-up` behaves safely:

- Starts `shared-postgres` if it exists but is stopped.
- Creates it only if it does not exist.
- Refuses to claim a port already used by a different container.
- Creates only this project's role, databases, and schemas when missing.
- Does not delete or recreate central resources.

## Development

```bash
make dev
```

In another terminal:

```bash
make check
make e2e
```

## First-use application flow

1. Open `http://127.0.0.1:3000/login` and sign in with the Platform Admin credentials from `.env`.
2. Provision a tenant at `/platform/tenants` and activate the Tenant Owner through the local invitation URL.
3. Complete `/app/setup`, then create scoped users/roles under `/app/access`.
4. Create organization, commercial, and fleet masters before operational records.
5. Exercise indent → allocation → trip → POD → invoice → receipt/vendor-payment in dependency order.
6. Reconcile records in Control Tower, Alerts, Data Imports, Governance, and Integrations.

Primary routes are documented in the implemented feature table in `README.md` and the delivery map in `FEATURES.md`.

## Targeted feature tests

The active Playwright matrix runs real frontend/backend/PostgreSQL behavior in Chromium and mobile Chromium:

```bash
# Complete matrix
make e2e

# One canonical feature gap
pnpm exec playwright test tests/e2e/all-feature-gaps.spec.ts \
  --project=chromium --grep "E2E-GAP-OPS02-01"

# Tenant foundation or identity/access
pnpm exec playwright test tests/e2e/fnd-01-tenant-foundation.spec.ts --project=chromium
pnpm exec playwright test tests/e2e/fnd-02-identity-access.spec.ts --project=chromium
```

Do not point Playwright at production. `ENABLE_TEST_HOOKS` must remain `false` for every non-local environment, and production startup rejects an enabled value.

## Local production-style deployment

```bash
make deploy-local
```

The command verifies/provisions shared PostgreSQL, applies committed migrations, builds frontend/backend, starts both, and checks backend and frontend readiness.

The committed local example enables `ENABLE_TEST_HOOKS=true` so Playwright can exercise retry-safe provisioning failure and recovery. The hook still requires an authenticated Platform Admin and the exact supported failure selector. Runtime configuration refuses to start when test hooks are enabled with `APP_ENV=production`; set the value to `false` in every non-local environment.

## Inspection

```bash
make postgres-status
docker logs --tail=200 shared-postgres
make health
```

## Data cleanup

There is intentionally no project command to stop or delete the central PostgreSQL container or volume. Clean only this project's databases/schemas through an explicitly reviewed project-specific migration or administrative command. Never use a broad Docker volume removal from this repository.

## Environment rules

- `.env` is local and ignored; commit only `.env.example` placeholders.
- Do not reuse local credentials outside local development.
- Frontend reads only public frontend variables and talks to the backend API.
- Backend owns all database access and secrets.
- E2E uses the project test database and local endpoints.
