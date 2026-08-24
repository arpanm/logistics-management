#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

for command_name in git node docker rg; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Missing required command: $command_name" >&2
    exit 1
  fi
done

if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm is required. Enable Corepack or install pnpm, then rerun bootstrap." >&2
  exit 1
fi

git config core.hooksPath .githooks

if find apps packages -mindepth 2 -name package.json -print -quit 2>/dev/null | grep -q .; then
  pnpm install --frozen-lockfile
else
  echo "Application packages are not present yet; FND-01 will bootstrap them."
fi

bash scripts/policy-check.sh
echo "Bootstrap checks passed."
