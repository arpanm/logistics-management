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
app_role="${POSTGRES_APP_USER:-logistics_app}"
app_password="${POSTGRES_APP_PASSWORD:-local-logistics-only}"
app_database="${POSTGRES_DB:-logistics}"
test_database="${POSTGRES_TEST_DB:-logistics_test}"

safe_identifier='^[a-z_][a-z0-9_]*$'
safe_password='^[A-Za-z0-9._-]+$'
for identifier in "$app_role" "$app_database" "$test_database"; do
  if [[ ! "$identifier" =~ $safe_identifier ]]; then
    echo "Unsafe PostgreSQL identifier: $identifier" >&2
    exit 1
  fi
done
if [[ ! "$app_password" =~ $safe_password ]]; then
  echo "POSTGRES_APP_PASSWORD may contain only letters, digits, dot, underscore, and hyphen for local provisioning." >&2
  exit 1
fi

if ! docker container inspect "$container_name" >/dev/null 2>&1; then
  echo "Shared PostgreSQL container does not exist. Run make postgres-up first." >&2
  exit 1
fi

role_exists="$(docker exec "$container_name" psql -U "$admin_user" -d postgres -tAc "SELECT 1 FROM pg_roles WHERE rolname = '$app_role'")"
if [[ "$role_exists" != "1" ]]; then
  docker exec "$container_name" psql -U "$admin_user" -d postgres -v ON_ERROR_STOP=1 \
    -c "CREATE ROLE $app_role LOGIN PASSWORD '$app_password'" >/dev/null
fi

for database_name in "$app_database" "$test_database"; do
  database_exists="$(docker exec "$container_name" psql -U "$admin_user" -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '$database_name'")"
  if [[ "$database_exists" != "1" ]]; then
    docker exec "$container_name" createdb -U "$admin_user" -O "$app_role" "$database_name"
  fi

  docker exec "$container_name" psql -U "$admin_user" -d "$database_name" -v ON_ERROR_STOP=1 \
    -c "CREATE SCHEMA IF NOT EXISTS app AUTHORIZATION $app_role; CREATE SCHEMA IF NOT EXISTS audit AUTHORIZATION $app_role; CREATE SCHEMA IF NOT EXISTS reporting AUTHORIZATION $app_role; GRANT CONNECT ON DATABASE $database_name TO $app_role;" >/dev/null
done

echo "Shared PostgreSQL ready: container=$container_name databases=$app_database,$test_database schemas=app,audit,reporting"
