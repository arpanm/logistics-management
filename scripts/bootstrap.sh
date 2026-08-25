#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

# shellcheck source=scripts/tooling.sh
source "$repo_dir/scripts/tooling.sh"

missing_commands=()
for command_name in git node docker; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    missing_commands+=("$command_name")
  fi
done

if (( ${#missing_commands[@]} > 0 )); then
  printf 'Missing required commands: %s\n' "${missing_commands[*]}" >&2
  exit 1
fi

resolve_pnpm
echo "Using $(run_pnpm --version | sed 's/^/pnpm /') with $(node --version)."

git config core.hooksPath .githooks

if find apps packages -mindepth 2 -name package.json -print -quit 2>/dev/null | grep -q .; then
  run_pnpm install --frozen-lockfile
else
  echo "Application packages are not present yet; FND-01 will bootstrap them."
fi

bash scripts/policy-check.sh
echo "Bootstrap checks passed."
