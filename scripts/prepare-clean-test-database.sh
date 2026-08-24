#!/usr/bin/env bash
set -euo pipefail

test_url="${TEST_DATABASE_URL:?TEST_DATABASE_URL is required}"
if [[ ! "$test_url" =~ /logistics_test([?]|$) ]]; then
  echo "Refusing clean migration test: TEST_DATABASE_URL must target logistics_test." >&2
  exit 1
fi

container_name="${CENTRAL_POSTGRES_CONTAINER:-shared-postgres}"
app_user="${POSTGRES_APP_USER:-logistics_app}"
test_database="${POSTGRES_TEST_DB:-logistics_test}"
if [[ ! "$test_database" =~ ^[a-z_][a-z0-9_]*$ ]] || [[ "$test_database" != "logistics_test" ]]; then
  echo "Refusing clean migration test: POSTGRES_TEST_DB must be exactly logistics_test." >&2
  exit 1
fi
if ! docker container inspect "$container_name" >/dev/null 2>&1; then
  echo "Shared PostgreSQL container is missing: $container_name" >&2
  exit 1
fi

docker exec -i "$container_name" psql -U "$app_user" -d "$test_database" -v ON_ERROR_STOP=1 <<'SQL'
CREATE SCHEMA IF NOT EXISTS fnd01_unrelated_sentinel;
CREATE TABLE IF NOT EXISTS fnd01_unrelated_sentinel.keep_me (id integer PRIMARY KEY);
INSERT INTO fnd01_unrelated_sentinel.keep_me(id) VALUES (1) ON CONFLICT DO NOTHING;
DROP SCHEMA IF EXISTS reporting CASCADE;
DROP SCHEMA IF EXISTS audit CASCADE;
DROP SCHEMA IF EXISTS app CASCADE;
DROP TABLE IF EXISTS public._prisma_migrations;
SQL
