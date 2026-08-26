#!/usr/bin/env bash
set -euo pipefail

repo_dir="/opt/logistics-management"
env_file="/etc/logistics-management.env"

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  exec sudo "$0" "$@"
fi

[[ -d "$repo_dir/.git" ]] || {
  echo "$repo_dir is not a Git checkout." >&2
  exit 1
}
[[ -r "$env_file" ]] || {
  echo "$env_file is missing or unreadable." >&2
  exit 1
}

set -a
# shellcheck disable=SC1090
source "$env_file"
set +a

required=(
  DATABASE_URL SSL_CERT_FILE POSTAL_DIRECTORY_FILE POSTAL_DIRECTORY_SHA256
  POSTAL_DIRECTORY_VERSION POSTAL_DIRECTORY_SOURCE_NAME
  POSTAL_DIRECTORY_SOURCE_URI POSTAL_DIRECTORY_IMPORTED_BY
)
for variable_name in "${required[@]}"; do
  [[ -n "${!variable_name:-}" ]] || {
    echo "$variable_name is required in $env_file." >&2
    exit 1
  }
done

[[ -r "$POSTAL_DIRECTORY_FILE" ]] || {
  echo "Postal CSV is missing or unreadable: $POSTAL_DIRECTORY_FILE" >&2
  exit 1
}
printf '%s  %s\n' "$POSTAL_DIRECTORY_SHA256" "$POSTAL_DIRECTORY_FILE" |
  sha256sum --check --status || {
  echo "Postal CSV checksum does not match POSTAL_DIRECTORY_SHA256." >&2
  exit 1
}

connection_target="$({
  node -e '
    const url = new URL(process.env.DATABASE_URL);
    process.stdout.write(`${url.hostname}\t${url.port || "5432"}\t${url.pathname.slice(1)}`);
  '
})"
IFS=$'\t' read -r rds_host rds_port database_name <<<"$connection_target"
[[ -n "$rds_host" && -n "$rds_port" && -n "$database_name" ]] || {
  echo "Could not derive the RDS target from DATABASE_URL." >&2
  exit 1
}

rds_master_user="${RDS_MASTER_USER:-postgres}"
read -rsp "RDS master password for $rds_master_user@$rds_host: " rds_master_password
printf '\n'
PGPASSWORD="$rds_master_password"
export PGPASSWORD
trap 'unset PGPASSWORD rds_master_password' EXIT

psql \
  "host=$rds_host port=$rds_port dbname=$database_name user=$rds_master_user sslmode=verify-full sslrootcert=$SSL_CERT_FILE" \
  -v ON_ERROR_STOP=1 \
  -f "$repo_dir/scripts/sql/postal-ownership-handoff.sql"

unset PGPASSWORD rds_master_password
trap - EXIT

sudo -u logistics bash -lc '
  set -euo pipefail
  cd /opt/logistics-management
  set -a
  source /etc/logistics-management.env
  set +a
  corepack pnpm --filter @logistics/db run postal:verify-ownership
  corepack pnpm --filter @logistics/db run postal:import -- \
    --file "$POSTAL_DIRECTORY_FILE" \
    --version "$POSTAL_DIRECTORY_VERSION" \
    --sha256 "$POSTAL_DIRECTORY_SHA256" \
    --source-name "$POSTAL_DIRECTORY_SOURCE_NAME" \
    --source-uri "$POSTAL_DIRECTORY_SOURCE_URI" \
    --imported-by "$POSTAL_DIRECTORY_IMPORTED_BY" \
    --activate true
'

systemctl restart logistics-backend.service logistics-frontend.service
curl --fail --silent --show-error --retry 30 --retry-delay 2 --retry-connrefused \
  "http://127.0.0.1:${BACKEND_PORT:-4000}/api/v1/health/ready"
printf '\nPostal ownership, import, activation, and application readiness succeeded.\n'
