#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"
if [[ -f .env ]]; then set -a; source .env; set +a; fi

database_name="${1:-${POSTGRES_DB:-logistics}}"
if [[ ! "$database_name" =~ ^[a-z_][a-z0-9_]*$ ]]; then
  echo "Unsafe PostgreSQL database name: $database_name" >&2
  exit 1
fi
container_name="${CENTRAL_POSTGRES_CONTAINER:-shared-postgres}"
admin_user="${CENTRAL_POSTGRES_ADMIN_USER:-postgres}"
if ! docker container inspect "$container_name" >/dev/null 2>&1; then
  echo "Shared PostgreSQL container is missing: $container_name" >&2
  exit 1
fi
docker exec -i "$container_name" psql -U "$admin_user" -d "$database_name" \
  -v ON_ERROR_STOP=1 <"$repo_dir/scripts/sql/postal-ownership-handoff.sql"
echo "Postal ownership hardened in database $database_name."
