#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bash "$repo_dir/scripts/check-node-version.sh" 22
bash "$repo_dir/scripts/check-node-version.sh" 24
if bash "$repo_dir/scripts/check-node-version.sh" 23 >/dev/null 2>&1; then
  echo "Node.js 23 was incorrectly accepted" >&2
  exit 1
fi
echo "Node.js runtime guard passed: 22 and 24 accepted; 23 rejected."
