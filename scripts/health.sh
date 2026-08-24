#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

docker compose ps --status running postgres redis minio mailpit >/dev/null

if [[ ! -d apps/web ]]; then
  echo "Infrastructure is running; application readiness is unavailable until FND-01." >&2
  exit 1
fi

health_url="${APP_URL:-http://127.0.0.1:3000}/api/health/ready"
attempt=0
until curl --fail --silent --show-error "$health_url" >/dev/null; do
  attempt=$((attempt + 1))
  if [[ "$attempt" -ge 30 ]]; then
    echo "Application readiness failed: $health_url" >&2
    exit 1
  fi
  sleep 1
done

echo "Local infrastructure and application are ready."

