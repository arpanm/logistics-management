#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
runtime_dir="$repo_dir/.sdlc/runtime"
cd "$repo_dir"

if [[ -f .env ]]; then
  set -a
  source .env
  set +a
else
  set -a
  source .env.example
  set +a
fi

bash scripts/postgres-up.sh

if [[ ! -d apps/frontend || ! -d apps/backend ]]; then
  echo "Shared PostgreSQL is healthy, but frontend/backend deployment requires FND-01." >&2
  exit 1
fi

pnpm run db:migrate
bash scripts/postgres-postal-handoff.sh "${POSTGRES_DB:-logistics}"
pnpm --filter @logistics/db postal:verify-ownership
pnpm run db:seed
pnpm run build

mkdir -p "$runtime_dir"
backend_screen="logistics-management-backend"
frontend_screen="logistics-management-frontend"

stop_owned_listener() {
  local port="$1"
  local listener_pid listener_cwd
  while IFS= read -r listener_pid; do
    [[ -n "$listener_pid" ]] || continue
    listener_cwd="$(lsof -a -p "$listener_pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')"
    case "$listener_cwd" in
      "$repo_dir"|"$repo_dir"/*)
        kill "$listener_pid"
        ;;
      *)
        echo "Refusing to stop process $listener_pid on port $port because it is not owned by this repository." >&2
        exit 1
        ;;
    esac
  done < <(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)
}

stop_owned_listener "${BACKEND_PORT:-4000}"
stop_owned_listener "${FRONTEND_PORT:-3000}"

for port in "${BACKEND_PORT:-4000}" "${FRONTEND_PORT:-3000}"; do
  attempts=0
  while lsof -tiTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; do
    attempts=$((attempts + 1))
    if [[ "$attempts" -ge 50 ]]; then
      echo "Owned process did not release port $port during restart." >&2
      exit 1
    fi
    sleep 0.1
  done
done

if command -v screen >/dev/null 2>&1; then
  screen -S "$backend_screen" -X quit >/dev/null 2>&1 || true
  screen -S "$frontend_screen" -X quit >/dev/null 2>&1 || true
  screen -dmS "$backend_screen" /usr/bin/env bash -lc "cd '$repo_dir/apps/backend' && echo \$\$ >'$runtime_dir/backend.pid' && exec node dist/main.js >>'$runtime_dir/backend.log' 2>&1"
  screen -dmS "$frontend_screen" /usr/bin/env bash -lc "cd '$repo_dir/apps/frontend' && echo \$\$ >'$runtime_dir/frontend.pid' && exec node node_modules/next/dist/bin/next start -H 127.0.0.1 -p '${FRONTEND_PORT:-3000}' >>'$runtime_dir/frontend.log' 2>&1"
  printf '%s\n%s\n' "$backend_screen" "$frontend_screen" >"$runtime_dir/app.session"
else
  if [[ -f "$runtime_dir/app.pid" ]] && kill -0 "$(cat "$runtime_dir/app.pid")" 2>/dev/null; then
    kill "$(cat "$runtime_dir/app.pid")"
  fi
  nohup pnpm run start:local >"$runtime_dir/app.log" 2>&1 </dev/null &
  echo "$!" >"$runtime_dir/app.pid"
fi

bash scripts/health.sh
echo "Frontend deployed at ${FRONTEND_URL:-http://127.0.0.1:3000}; backend at ${BACKEND_URL:-http://127.0.0.1:4000}."
