# Local Development and Deployment

## Services

Docker Compose provides:

- PostgreSQL on `127.0.0.1:5432`
- Redis on `127.0.0.1:6379`
- MinIO API on `127.0.0.1:9000` and console on `127.0.0.1:9001`
- Mailpit SMTP on `127.0.0.1:1025` and UI on `127.0.0.1:8025`

Application defaults use `http://127.0.0.1:3000`.

## Setup

```bash
cp .env.example .env
make bootstrap
make infra-up
```

`bootstrap` configures repository Git hooks and installs packages after the application workspace exists.

## Development

```bash
make dev
```

In another terminal:

```bash
make check
make e2e
```

## Local production-style deployment

```bash
make deploy-local
```

This starts infrastructure, applies committed migrations, builds the workspace, and starts the local production entrypoint. `FND-01` must provide the application scripts used by this target.

## Service inspection

```bash
docker compose ps
docker compose logs --tail=200 postgres redis minio mailpit
make health
```

## Safe reset

`make infra-down` keeps local volumes. `make infra-reset` deletes local Compose volumes and therefore all local database/object data; it requires an explicit `CONFIRM_LOCAL_DATA_DELETE=yes` environment value.

```bash
CONFIRM_LOCAL_DATA_DELETE=yes make infra-reset
```

Never point local reset scripts at shared or non-local environments.

## Environment rules

- `.env` is local and ignored. Commit only `.env.example` with non-secret placeholders.
- Local credentials are intentionally low-risk defaults but must never be reused outside local development.
- Any connector or provider integration defaults to a safe stub/sandbox until explicitly configured.
- E2E must use local endpoints and a dedicated test tenant/database.

