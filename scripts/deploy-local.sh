#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
runtime_dir="$repo_dir/.sdlc/runtime"
cd "$repo_dir"

bash scripts/postgres-up.sh

if [[ ! -d apps/frontend || ! -d apps/backend ]]; then
  echo "Shared PostgreSQL is healthy, but frontend/backend deployment requires FND-01." >&2
  exit 1
fi

pnpm run db:migrate
pnpm run build

mkdir -p "$runtime_dir"
if [[ -f "$runtime_dir/app.pid" ]] && kill -0 "$(cat "$runtime_dir/app.pid")" 2>/dev/null; then
  kill "$(cat "$runtime_dir/app.pid")"
fi

nohup pnpm run start:local >"$runtime_dir/app.log" 2>&1 &
echo "$!" >"$runtime_dir/app.pid"

bash scripts/health.sh
echo "Frontend deployed at ${FRONTEND_URL:-http://127.0.0.1:3000}; backend at ${BACKEND_URL:-http://127.0.0.1:4000}."
