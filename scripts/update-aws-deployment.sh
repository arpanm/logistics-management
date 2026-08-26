#!/usr/bin/env bash
set -euo pipefail

repo_dir="${REPO_DIR:-/opt/logistics-management}"
deploy_user="${DEPLOY_USER:-logistics}"

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  exec sudo "$0" "$@"
fi
id "$deploy_user" >/dev/null 2>&1 || {
  echo "Deployment user does not exist: $deploy_user" >&2
  exit 1
}
[[ -d "$repo_dir/.git" ]] || {
  echo "$repo_dir is not a Git checkout." >&2
  exit 1
}

sudo -u "$deploy_user" git -C "$repo_dir" fetch --no-tags origin main
commit_sha="$(sudo -u "$deploy_user" git -C "$repo_dir" rev-parse origin/main)"
sudo -u "$deploy_user" "$repo_dir/scripts/deploy-aws.sh" "$commit_sha"
