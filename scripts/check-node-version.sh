#!/usr/bin/env bash
set -euo pipefail

node_major="${1:-$(node -p 'process.versions.node.split(".")[0]')}"
if [[ ! "$node_major" =~ ^[0-9]+$ ]] || (( node_major != 22 && node_major != 24 )); then
  detected="${1:-$(node --version)}"
  cat >&2 <<EOF
Unsupported Node.js $detected. This repository supports Node.js 22 or 24.
On Homebrew, run: brew install node@22 && brew unlink node && brew link --overwrite node@22
Then open a new shell and rerun make bootstrap.
EOF
  exit 1
fi
