#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

bash scripts/run-workspace-checks.sh
bash scripts/run-workspace-tests.sh

if [[ -d apps/frontend && -d apps/backend ]]; then
  bash scripts/health.sh
  bash scripts/e2e.sh
else
  echo "Scaffold verification complete. FND-01 must add frontend, backend, deployment, and E2E gates."
fi
