#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

required_files=(
  AGENTS.md
  FEATURES.md
  README.md
  TODO.md
  docs/ARCHITECTURE.md
  docs/SDLC.md
  docs/TESTING.md
  .codex/config.toml
  .agents/skills/feature-sdlc/SKILL.md
  .codex/templates/feature-spec.md
  .codex/templates/test-plan.md
  .codex/templates/completion.md
)

for required_file in "${required_files[@]}"; do
  if [[ ! -s "$required_file" ]]; then
    echo "Missing or empty required SDLC file: $required_file" >&2
    exit 1
  fi
done

feature_count="$(grep -Ec '^## (FND|MST|OPS|DOC|FIN|CTL|ALT|DAT|GOV|INT|CFG)-' FEATURES.md)"
prompt_count="$(grep -Ec '^### Master prompt for Codex' FEATURES.md)"
if [[ "$feature_count" -ne "$prompt_count" ]]; then
  echo "Feature/prompt count mismatch: $feature_count features, $prompt_count prompts." >&2
  exit 1
fi

test_status_count="$(grep -Ec '^\*\*Test status:\*\*' FEATURES.md)"
if [[ "$test_status_count" -ne "$feature_count" ]]; then
  echo "Feature/test-status count mismatch: $feature_count features, $test_status_count section test statuses." >&2
  exit 1
fi

register_test_status_count="$(grep -E '^\| (FND|MST|OPS|DOC|FIN|CTL|ALT|DAT|GOV|INT|CFG)-' FEATURES.md | grep -Ec '\| (Not started|Planned|Implemented|Failing|Passing|Blocked)[[:space:]]*\|')"
if [[ "$register_test_status_count" -ne "$feature_count" ]]; then
  echo "Feature register must include a valid test status for all $feature_count features." >&2
  exit 1
fi

agent_count="$(find .codex/agents -type f -name '*.toml' | wc -l | tr -d ' ')"
if [[ "$agent_count" -lt 5 ]]; then
  echo "Expected at least five project agents; found $agent_count." >&2
  exit 1
fi

node scripts/status-sync-check.mjs

if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if git ls-files backup | grep -q .; then
    echo "Files under backup/ must not be tracked." >&2
    exit 1
  fi
  if git grep -n -I -E '(BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|AKIA[0-9A-Z]{16})' -- ':!backup/**' ':!.env.example' >/dev/null 2>&1; then
    echo "Possible committed secret material detected." >&2
    exit 1
  fi
fi

echo "Repository policy checks passed: $feature_count features, $test_status_count test statuses, and $agent_count custom agents."
