#!/usr/bin/env bash
set -euo pipefail

requested_command="${1:?application command is required}"
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

if [[ ! -d apps/web ]]; then
  echo "Application baseline is not present. Implement FND-01 before running '$requested_command'." >&2
  exit 1
fi

case "$requested_command" in
  dev)
    pnpm --parallel --filter './apps/*' run dev
    ;;
  build)
    pnpm -r --filter './packages/*' --filter './apps/*' --if-present run build
    ;;
  start:local)
    pnpm --parallel --filter './apps/*' --if-present run start
    ;;
  db:migrate)
    pnpm --filter @logistics/db run db:migrate
    ;;
  *)
    echo "Unsupported application command: $requested_command" >&2
    exit 1
    ;;
esac

