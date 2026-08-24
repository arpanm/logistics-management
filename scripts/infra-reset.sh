#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

if [[ "${CONFIRM_LOCAL_DATA_DELETE:-}" != "yes" ]]; then
  echo "Refusing to delete local volumes. Run with CONFIRM_LOCAL_DATA_DELETE=yes." >&2
  exit 1
fi

docker compose down --volumes --remove-orphans
echo "Deleted this project's local Compose containers and volumes."

