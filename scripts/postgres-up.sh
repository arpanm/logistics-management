#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

container_name="${CENTRAL_POSTGRES_CONTAINER:-shared-postgres}"
volume_name="${CENTRAL_POSTGRES_VOLUME:-shared-postgres-data}"
host_port="${CENTRAL_POSTGRES_PORT:-5432}"
admin_user="${CENTRAL_POSTGRES_ADMIN_USER:-postgres}"
admin_password="${CENTRAL_POSTGRES_ADMIN_PASSWORD:-local-postgres-only}"

if docker container inspect "$container_name" >/dev/null 2>&1; then
  if [[ "$(docker inspect -f '{{.State.Running}}' "$container_name")" != "true" ]]; then
    docker start "$container_name" >/dev/null
  fi
else
  if docker ps --format '{{.Ports}}' | rg -q "127\.0\.0\.1:${host_port}->|0\.0\.0\.0:${host_port}->|:::${host_port}->"; then
    echo "Port ${host_port} is already used by another container. Set CENTRAL_POSTGRES_PORT to the existing shared PostgreSQL port or stop the conflicting container." >&2
    exit 1
  fi

  docker run -d \
    --name "$container_name" \
    --restart unless-stopped \
    -e "POSTGRES_USER=$admin_user" \
    -e "POSTGRES_PASSWORD=$admin_password" \
    -e "POSTGRES_DB=postgres" \
    -p "127.0.0.1:${host_port}:5432" \
    -v "${volume_name}:/var/lib/postgresql/data" \
    postgres:16-alpine >/dev/null
fi

attempt=0
until docker exec "$container_name" pg_isready -U "$admin_user" -d postgres >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [[ "$attempt" -ge 30 ]]; then
    echo "Shared PostgreSQL container did not become ready: $container_name" >&2
    exit 1
  fi
  sleep 1
done

bash scripts/postgres-provision.sh
