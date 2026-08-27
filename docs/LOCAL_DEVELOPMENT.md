# Local Development and Deployment

## Runtime components

- Central shared PostgreSQL Docker container on `127.0.0.1:5432`
- Frontend on `127.0.0.1:3000`
- Backend on `127.0.0.1:4000`

No other local infrastructure containers are required.

## Central PostgreSQL ownership

`shared-postgres` and volume `shared-postgres-data` are reusable workstation resources. This repository may create or start them and provision its own resources. It must not stop, reset, or delete them.

Project defaults:

| Resource              | Value                                                  |
| --------------------- | ------------------------------------------------------ |
| Application database  | `logistics`                                            |
| Test database         | `logistics_test`                                       |
| Application role      | `logistics_app`                                        |
| Postal owner/importer | `logistics_postal_owner` / `logistics_postal_importer` |
| Schemas               | `app`, `audit`, `reporting`, `postal_reference`        |

Configure different names in `.env` if they conflict with an existing project. Use lowercase PostgreSQL-safe identifiers.

## Setup

Install Node.js 22 LTS and pnpm 11 first. On macOS:

```bash
brew install node@22 pnpm
```

The commit hook resolves either a standalone `pnpm` or `corepack pnpm`, and includes standard Homebrew paths when Git supplies a reduced environment. Installing pnpm alone is not enough: `make bootstrap` installs the locked workspace dependencies and configures the repository hooks.

```bash
cp .env.example .env
make bootstrap
make postgres-up
make postgres-status
```

Run `make bootstrap` immediately after cloning and again after changes to `package.json` or `pnpm-lock.yaml`. The commit hook performs the lightweight batch gate (policy/status, formatting, lint, and type checking); it does not run database, browser, or full regression tests automatically.

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

`make dev` runs Next.js and NestJS watchers and hot reloads source changes. Do not leave a production-style `make deploy-local` instance on the same ports when starting it.

If the local application is already running through `make deploy-local`, source edits do not hot reload. Refresh that runtime after an implementation batch with:

```bash
make refresh-local
```

This command applies forward migrations, builds all shared packages before both apps, restarts only listeners owned by this repository, and verifies readiness. It does not run tests, reseed the Platform Admin, or delete/reset tenant data.

Run checks only when explicitly starting a batch/release test phase:

```bash
make check
make test
make e2e
```

## First-use application flow

1. Open `http://127.0.0.1:3000/login` and sign in with the Platform Admin credentials from `.env` (defaults: `admin@local.test` / `LocalAdmin!234`). `make deploy-local` reseeds this account and resets it to the current environment password.
2. Provision a tenant at `/platform/tenants` and activate the Tenant Owner through the local invitation URL.
3. Complete `/app/setup`, then create scoped users/roles under `/app/access`.
4. Create organization, commercial, and fleet masters before operational records.
5. Exercise indent → allocation → trip → POD → invoice → receipt/vendor-payment in dependency order.
6. Reconcile records in Control Tower, Alerts, Data Imports, Governance, and Integrations.

Primary routes are documented in the implemented feature table in `README.md` and the delivery map in `FEATURES.md`.

The Platform Admin credential is only for tenant provisioning and platform operations. Tenant Owners and other tenant users authenticate with credentials established from their own invitation links; there is no shared tenant-admin password.

The local adapter does not deliver real email. A missed or expired first-owner link can be replaced from Platform Admin → Tenants → tenant details. The replacement link is shown once, the old token is invalidated, and the action requires a reason and is audited. Tenant-level users are then managed by the activated Tenant Owner at `/app/access/users`.

Local/test origin validation accepts both `http://127.0.0.1:3000` and `http://localhost:3000` when port 3000 is configured. It still rejects other hosts, schemes, and ports. Production accepts only the exact `FRONTEND_URL` origin.

## Explicit batch/release test phase

Do not run these commands automatically after each feature or fix. When testing is explicitly requested, select the smallest requested scope and run it once:

```bash
# Full matrix (release/full-regression request only)
make e2e

# One canonical feature gap
pnpm exec playwright test tests/e2e/all-feature-gaps.spec.ts \
  --project=chromium --grep "E2E-GAP-OPS02-01"

# Tenant foundation or identity/access
pnpm exec playwright test tests/e2e/fnd-01-tenant-foundation.spec.ts --project=chromium
pnpm exec playwright test tests/e2e/fnd-02-identity-access.spec.ts --project=chromium
```

Do not point Playwright at production. `ENABLE_TEST_HOOKS` must remain `false` for every non-local environment, and production startup rejects an enabled value.

Record each result as Passing, Failing, or Blocked. Do not automatically fix, retry, or rerun failures.

## Local production-style deployment

```bash
make deploy-local
```

The command verifies/provisions shared PostgreSQL, applies committed migrations, performs the idempotent administrator ownership handoff for `postal_reference`, verifies runtime read-only privileges, builds frontend/backend, starts both, and checks backend and frontend readiness.

Use `make deploy-local` for first setup or when deterministic reseeding is explicitly wanted. Use `make refresh-local` for normal code updates so existing tenant/user data and the Platform Admin password are preserved.

Tenant provisioning is PIN-first. Local/E2E uses a small deterministic postal fixture; city and state are derived and read-only. The production India directory is never downloaded at runtime and must be imported from a checksum-pinned official CSV using the AWS runbook in `README.md`.

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
