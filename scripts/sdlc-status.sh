#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

echo "Feature register:"
rg '^\| (FND|MST|OPS|DOC|FIN|CTL|ALT|DAT|GOV|INT|CFG)-' FEATURES.md
echo
echo "Git state:"
git status --short --branch

