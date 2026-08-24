#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

bash scripts/postgres-status.sh >/dev/null

if [[ ! -d apps/frontend || ! -d apps/backend ]]; then
  echo "Shared PostgreSQL is ready; frontend/backend readiness requires FND-01." >&2
  exit 1
fi

backend_health="${BACKEND_URL:-http://127.0.0.1:4000}/api/v1/health/ready"
frontend_health="${FRONTEND_URL:-http://127.0.0.1:3000}"

for health_url in "$backend_health" "$frontend_health"; do
  attempt=0
  until curl --fail --silent --show-error "$health_url" >/dev/null; do
    attempt=$((attempt + 1))
    if [[ "$attempt" -ge 30 ]]; then
      echo "Local readiness failed: $health_url" >&2
      exit 1
    fi
    sleep 1
  done
done

echo "Shared PostgreSQL, backend, and frontend are ready."
