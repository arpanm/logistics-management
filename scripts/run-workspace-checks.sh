#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

bash scripts/policy-check.sh
git diff --check

if [[ ! -d apps/frontend || ! -d apps/backend ]]; then
  echo "Frontend/backend baseline not present; repository policy checks passed."
  exit 0
fi

for check_name in format:check lint typecheck test; do
  echo "Running workspace check: $check_name"
  pnpm -r --filter './packages/*' --filter './apps/*' --if-present run "$check_name"
done
