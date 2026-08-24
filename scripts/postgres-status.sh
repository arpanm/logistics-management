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
admin_user="${CENTRAL_POSTGRES_ADMIN_USER:-postgres}"
app_database="${POSTGRES_DB:-logistics}"

if ! docker container inspect "$container_name" >/dev/null 2>&1; then
  echo "Shared PostgreSQL container is missing: $container_name" >&2
  exit 1
fi
if [[ "$(docker inspect -f '{{.State.Running}}' "$container_name")" != "true" ]]; then
  echo "Shared PostgreSQL container is stopped: $container_name" >&2
  exit 1
fi

docker exec "$container_name" pg_isready -U "$admin_user" -d "$app_database"
