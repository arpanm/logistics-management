# Runbook — Local Frontend/Backend Deployment

## Preconditions

- `.env` exists from `.env.example`.
- Docker engine is running.
- Central PostgreSQL settings identify the shared workstation container.
- Dependencies are installed.
- No unrelated migration is active for this project's databases.

## Deploy

```bash
make deploy-local
```

## Verify when explicitly requested

Deployment and tests are batch/release actions, not automatic per-feature gates. For a requested release verification, run the selected scope once:

```bash
make postgres-status
make health
make e2e      # full browser regression only when requested
make verify   # full repository verification only when requested
```

Confirm project database/schema access, backend readiness, frontend availability, and local-only Playwright endpoints.

Record failures without automatically retrying or fixing them unless the user asks.

## Failure triage

1. Run `make postgres-status` and inspect bounded `shared-postgres` logs.
2. Confirm this project's role/database/schema configuration and migrations.
3. Inspect `.sdlc/runtime/backend.log` and `.sdlc/runtime/frontend.log` without printing secrets.
4. Verify backend and frontend ports and URLs.
5. Re-run the smallest failing check.

Do not stop, reset, or delete the shared PostgreSQL container/volume from this project.

Local/E2E deployments enable guarded test hooks. The backend rejects that setting when `APP_ENV=production`; never bypass this startup invariant. The deployment command restarts only listeners whose working directory belongs to this repository and refuses to terminate unrelated port owners.
