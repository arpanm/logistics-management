#!/usr/bin/env bash
set -euo pipefail

requested_command="${1:?application command is required}"
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
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

if [[ ! -d apps/frontend || ! -d apps/backend ]]; then
  echo "Frontend/backend baseline is not present. Implement FND-01 before running '$requested_command'." >&2
  exit 1
fi

case "$requested_command" in
  dev)
    pnpm --parallel --filter './apps/frontend' --filter './apps/backend' run dev
    ;;
  build)
    NODE_ENV=production pnpm -r --filter './packages/*' --filter './apps/frontend' --filter './apps/backend' --if-present run build
    ;;
  start:local)
    NODE_ENV=production pnpm --parallel --filter './apps/frontend' --filter './apps/backend' run start
    ;;
  db:migrate)
    pnpm --filter @logistics/db run db:migrate
    ;;
  *)
    echo "Unsupported application command: $requested_command" >&2
    exit 1
    ;;
esac
