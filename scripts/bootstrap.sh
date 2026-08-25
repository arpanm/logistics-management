#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

bootstrap_mode="${1:-local}"
if [[ "$bootstrap_mode" != "local" && "$bootstrap_mode" != "production" ]]; then
  echo "Usage: $0 [local|production]" >&2
  exit 1
fi

# shellcheck source=scripts/tooling.sh
source "$repo_dir/scripts/tooling.sh"

missing_commands=()
required_commands=(git node)
if [[ "$bootstrap_mode" == "local" ]]; then
  required_commands+=(docker)
fi
for command_name in "${required_commands[@]}"; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    missing_commands+=("$command_name")
  fi
done

if (( ${#missing_commands[@]} > 0 )); then
  printf 'Missing required commands: %s\n' "${missing_commands[*]}" >&2
  exit 1
fi

bash "$repo_dir/scripts/check-node-version.sh"

resolve_pnpm
echo "Using $(run_pnpm --version | sed 's/^/pnpm /') with $(node --version)."

git config core.hooksPath .githooks

if find apps packages -mindepth 2 -name package.json -print -quit 2>/dev/null | grep -q .; then
  run_pnpm install --frozen-lockfile
else
  echo "Application packages are not present yet; FND-01 will bootstrap them."
fi

bash scripts/policy-check.sh
if [[ "$bootstrap_mode" == "production" ]]; then
  echo "Production bootstrap checks passed."
else
  echo "Local bootstrap checks passed."
fi
