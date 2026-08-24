# Runbook — Local Deployment Verification

## Preconditions

- `.env` exists from `.env.example`.
- Docker engine is running.
- Dependencies are installed.
- No unrelated local migration process is active.

## Deploy

```bash
make deploy-local
```

## Verify

```bash
make health
make e2e
make verify
```

Confirm PostgreSQL, Redis, MinIO, Mailpit, web, and worker readiness. Confirm the browser test uses local endpoints.

## Failure triage

1. Inspect `docker compose ps` and health states.
2. Inspect bounded service logs; do not print environment secrets.
3. Confirm ports and `.env` local URLs.
4. Verify migrations against the local database.
5. Re-run the smallest failing check.

Do not use `infra-reset` until local data deletion is intended and explicitly confirmed.

