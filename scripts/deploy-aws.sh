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

# shellcheck source=scripts/tooling.sh
source "$repo_dir/scripts/tooling.sh"
resolve_pnpm

bash "$repo_dir/scripts/validate-production-env.sh" "$env_file"

set -a
# shellcheck disable=SC1090
source "$env_file"
set +a

if [[ "${APP_ENV:-}" != "production" ]]; then
  echo "APP_ENV must be production for AWS deployment." >&2
  exit 1
fi
required_postal_variables=(
  POSTAL_IMPORT_DATABASE_URL POSTAL_IMPORT_EXPECTED_DATABASE
  POSTAL_DIRECTORY_FILE POSTAL_DIRECTORY_SHA256
  POSTAL_DIRECTORY_VERSION POSTAL_DIRECTORY_SOURCE_NAME
  POSTAL_DIRECTORY_SOURCE_URI POSTAL_DIRECTORY_IMPORTED_BY
)
for variable_name in "${required_postal_variables[@]}"; do
  if [[ -z "${!variable_name:-}" ]]; then
    echo "$variable_name is required for the offline postal-directory activation." >&2
    exit 1
  fi
done
if [[ "$POSTAL_IMPORT_DATABASE_URL" == "${DATABASE_URL:-}" ]]; then
  echo "POSTAL_IMPORT_DATABASE_URL must use logistics_postal_importer, not the runtime credential." >&2
  exit 1
fi
if [[ ! -r "$POSTAL_DIRECTORY_FILE" ]]; then
  echo "POSTAL_DIRECTORY_FILE is missing or unreadable: $POSTAL_DIRECTORY_FILE" >&2
  exit 1
fi

run_pnpm install --frozen-lockfile
run_pnpm --filter @logistics/db run db:migrate
run_pnpm --filter @logistics/db postal:verify-ownership
run_pnpm --filter @logistics/db postal:import -- \
  --file "$POSTAL_DIRECTORY_FILE" \
  --version "$POSTAL_DIRECTORY_VERSION" \
  --sha256 "$POSTAL_DIRECTORY_SHA256" \
  --source-name "$POSTAL_DIRECTORY_SOURCE_NAME" \
  --source-uri "$POSTAL_DIRECTORY_SOURCE_URI" \
  --imported-by "$POSTAL_DIRECTORY_IMPORTED_BY" \
  --activate true
run_pnpm run build

sudo systemctl restart logistics-backend.service logistics-frontend.service
sudo systemctl is-active --quiet logistics-backend.service
sudo systemctl is-active --quiet logistics-frontend.service

curl --fail --silent --show-error --retry 20 --retry-delay 2 \
  "http://127.0.0.1:${BACKEND_PORT:-4000}/api/v1/health/ready" >/dev/null
curl --fail --silent --show-error --retry 20 --retry-delay 2 \
  "http://127.0.0.1:${FRONTEND_PORT:-3000}/login" >/dev/null

echo "Deployed $commit_sha successfully."
