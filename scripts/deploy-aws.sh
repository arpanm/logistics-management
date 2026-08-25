#!/usr/bin/env bash
set -euo pipefail

commit_sha="${1:?commit SHA is required}"
repo_dir="/opt/logistics-management"
env_file="/etc/logistics-management.env"
lock_file="/tmp/logistics-management-deploy.lock"

[[ "$commit_sha" =~ ^[0-9a-f]{40}$ ]] || {
  echo "Refusing invalid commit SHA." >&2
  exit 1
}
[[ -d "$repo_dir/.git" ]] || {
  echo "$repo_dir is not a Git checkout." >&2
  exit 1
}
[[ -r "$env_file" ]] || {
  echo "$env_file is missing or unreadable." >&2
  exit 1
}

exec 9>"$lock_file"
flock -n 9 || {
  echo "Another deployment is already running." >&2
  exit 1
}

cd "$repo_dir"
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "The dedicated deployment checkout has tracked changes; refusing to overwrite them." >&2
  exit 1
fi

git fetch --no-tags origin main
git cat-file -e "$commit_sha^{commit}"
git merge-base --is-ancestor "$commit_sha" origin/main || {
  echo "Requested commit is not reachable from origin/main." >&2
  exit 1
}
git checkout --detach "$commit_sha"

set -a
# shellcheck disable=SC1090
source "$env_file"
set +a

corepack pnpm install --frozen-lockfile
corepack pnpm run db:migrate
corepack pnpm run build

sudo systemctl restart logistics-backend.service logistics-frontend.service
sudo systemctl is-active --quiet logistics-backend.service
sudo systemctl is-active --quiet logistics-frontend.service

curl --fail --silent --show-error --retry 20 --retry-delay 2 \
  "http://127.0.0.1:${BACKEND_PORT:-4000}/api/v1/health/ready" >/dev/null
curl --fail --silent --show-error --retry 20 --retry-delay 2 \
  "http://127.0.0.1:${FRONTEND_PORT:-3000}/login" >/dev/null

echo "Deployed $commit_sha successfully."
