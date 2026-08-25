#!/usr/bin/env bash

# Git hooks launched from GUI tools can receive a smaller PATH than an
# interactive shell. Include the standard Homebrew prefixes before resolving
# project tools.
for tooling_path in /opt/homebrew/bin /usr/local/bin; do
  case ":$PATH:" in
    *":$tooling_path:"*) ;;
    *) PATH="$tooling_path:$PATH" ;;
  esac
done
export PATH

resolve_pnpm() {
  if command -v pnpm >/dev/null 2>&1; then
    PNPM_COMMAND=(pnpm)
    return 0
  fi

  if command -v corepack >/dev/null 2>&1; then
    PNPM_COMMAND=(corepack pnpm)
    return 0
  fi

  cat >&2 <<'EOF'
pnpm is required but was not found on the Git-hook PATH.

macOS:
  brew install node@22 pnpm

Node.js 22 with Corepack:
  corepack enable
  corepack prepare pnpm@11.19.0 --activate

Then run:
  make bootstrap
EOF
  return 1
}

run_pnpm() {
  "${PNPM_COMMAND[@]}" "$@"
}
