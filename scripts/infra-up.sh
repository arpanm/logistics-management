#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "Created .env from .env.example. Replace placeholder secrets before implementing authentication."
fi

docker compose up -d --wait postgres redis minio mailpit
docker compose up --no-deps minio-init
docker compose ps

