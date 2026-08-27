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

backend_port="${BACKEND_PORT:-4000}"
frontend_port="${FRONTEND_PORT:-3000}"

bash scripts/postgres-up.sh
pnpm run db:migrate
# Build all workspace packages before the apps. Building an app alone can leave
# stale package dist exports and produce a backend that compiles but cannot boot.
pnpm run build

mkdir -p "$runtime_dir"

stop_owned_listener() {
  local port="$1"
  local listener_pid listener_cwd
  while IFS= read -r listener_pid; do
    [[ -n "$listener_pid" ]] || continue
    listener_cwd="$(lsof -a -p "$listener_pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')"
    case "$listener_cwd" in
      "$repo_dir"|"$repo_dir"/*) kill "$listener_pid" ;;
      *)
        echo "Refusing to stop process $listener_pid on port $port because it is not owned by this repository." >&2
        exit 1
        ;;
    esac
  done < <(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)
}

stop_owned_listener "$backend_port"
stop_owned_listener "$frontend_port"

for port in "$backend_port" "$frontend_port"; do
  attempts=0
  while lsof -tiTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; do
    attempts=$((attempts + 1))
    if [[ "$attempts" -ge 50 ]]; then
      echo "Owned process did not release port $port during refresh." >&2
      exit 1
    fi
    sleep 0.1
  done
done

screen -S logistics-management-backend -X quit >/dev/null 2>&1 || true
screen -S logistics-management-frontend -X quit >/dev/null 2>&1 || true
screen -dmS logistics-management-backend /usr/bin/env bash -lc "cd '$repo_dir/apps/backend' && echo \$\$ >'$runtime_dir/backend.pid' && exec node dist/main.js >>'$runtime_dir/backend.log' 2>&1"
screen -dmS logistics-management-frontend /usr/bin/env bash -lc "cd '$repo_dir/apps/frontend' && echo \$\$ >'$runtime_dir/frontend.pid' && exec node node_modules/next/dist/bin/next start -H 127.0.0.1 -p '$frontend_port' >>'$runtime_dir/frontend.log' 2>&1"
printf '%s\n%s\n' logistics-management-backend logistics-management-frontend >"$runtime_dir/app.session"

bash scripts/health.sh
echo "Local services refreshed without reseeding: ${FRONTEND_URL:-http://127.0.0.1:3000}"
