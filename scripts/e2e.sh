#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

if [[ ! -d apps/frontend || ! -d apps/backend ]]; then
  echo "Playwright acceptance requires the FND-01 frontend/backend baseline." >&2
  exit 1
fi

bash scripts/health.sh
pnpm exec playwright test "$@"
