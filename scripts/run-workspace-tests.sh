#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

# shellcheck source=scripts/tooling.sh
source "$repo_dir/scripts/tooling.sh"
resolve_pnpm

if [[ -f .env ]]; then
  set -a
  source .env
  set +a
else
  set -a
  source .env.example
  set +a
fi

echo "Running explicitly requested non-browser test suites"
run_pnpm -r --filter './packages/*' --filter './apps/*' --if-present run test
