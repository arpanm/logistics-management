#!/usr/bin/env bash
set -euo pipefail

# Run on a fresh Ubuntu EC2 host. Required inputs:
#   REPOSITORY_URL, RDS_HOST, PUBLIC_ORIGIN
# Optional: REPOSITORY_REF, RDS_MASTER_USER, PLATFORM_ADMIN_EMAIL.

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  exec sudo --preserve-env=REPOSITORY_URL,REPOSITORY_REF,RDS_HOST,PUBLIC_ORIGIN,RDS_MASTER_USER,PLATFORM_ADMIN_EMAIL "$0" "$@"
fi

repository_url="${REPOSITORY_URL:?Set REPOSITORY_URL (SSH or HTTPS Git URL).}"
repository_ref="${REPOSITORY_REF:-main}"
rds_host="${RDS_HOST:?Set RDS_HOST to the private RDS endpoint.}"
public_origin="${PUBLIC_ORIGIN:?Set PUBLIC_ORIGIN, for example http://EC2_PUBLIC_IP or https://logistics.example.com.}"
rds_master_user="${RDS_MASTER_USER:-postgres}"
admin_email="${PLATFORM_ADMIN_EMAIL:-}"
repo_dir="/opt/logistics-management"
env_file="/etc/logistics-management.env"
postal_source_rel="data/postal/india-post-pincode-directory-ogd-2025-10-03.csv"
postal_target="/opt/logistics-secrets/india-post-pincode-directory.csv"
postal_sha256="701ee84ba125a914e7ffc979c0308b3a041b8adffa85ec9d5f4e0579ecf062e5"

[[ "$public_origin" =~ ^https?://[^/]+$ ]] || {
  echo "PUBLIC_ORIGIN must be a single HTTP(S) origin without a path." >&2
  exit 1
}
[[ "$rds_host" =~ ^[A-Za-z0-9.-]+\.rds\.amazonaws\.com$ ]] || {
  echo "RDS_HOST must be an AWS RDS DNS endpoint without a scheme or port." >&2
  exit 1
}
if [[ -z "$admin_email" ]]; then
  read -rp "Production Platform Admin email: " admin_email
fi
read -rsp "Production Platform Admin password (12+ characters): " admin_password
printf '\n'
[[ ${#admin_password} -ge 12 ]] || {
  echo "Platform Admin password must be at least 12 characters." >&2
  exit 1
}
[[ "$admin_email" == *@* && "$public_origin" != *"'"* && "$admin_email" != *"'"* && "$admin_email" != *$'\n'* && "$admin_password" != *"'"* && "$admin_password" != *$'\n'* ]] || {
  echo "PUBLIC_ORIGIN and admin credentials must be valid single-line values without single quotes; the email must contain @." >&2
  exit 1
}
read -rsp "RDS master password for $rds_master_user@$rds_host: " rds_master_password
printf '\n'

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y git nginx postgresql-client curl build-essential jq ca-certificates openssl
if ! command -v node >/dev/null || [[ "$(node --version | sed 's/^v//' | cut -d. -f1)" -lt 22 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
corepack enable

if ! id logistics >/dev/null 2>&1; then
  useradd --system --create-home --shell /bin/bash logistics
fi
install -d -o logistics -g logistics -m 0755 "$repo_dir"
if [[ ! -d "$repo_dir/.git" ]]; then
  rmdir "$repo_dir"
  sudo -u logistics git clone "$repository_url" "$repo_dir"
fi
sudo -u logistics git -C "$repo_dir" fetch --no-tags origin "$repository_ref"
sudo -u logistics git -C "$repo_dir" checkout --detach FETCH_HEAD

if ! swapon --show=NAME --noheadings | grep -qx /swapfile; then
  if [[ ! -f /swapfile ]]; then
    fallocate -l 2G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile >/dev/null
  fi
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
fi

curl -fsSLo /tmp/aws-rds-global-bundle.pem \
  https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
install -o root -g root -m 0644 /tmp/aws-rds-global-bundle.pem \
  /etc/ssl/certs/aws-rds-global-bundle.pem
rm -f /tmp/aws-rds-global-bundle.pem

[[ -f "$repo_dir/$postal_source_rel" ]] || {
  echo "Committed postal dataset is missing: $postal_source_rel" >&2
  exit 1
}
printf '%s  %s\n' "$postal_sha256" "$repo_dir/$postal_source_rel" | sha256sum --check --status || {
  echo "Committed postal dataset checksum failed." >&2
  exit 1
}
install -d -o root -g logistics -m 0750 /opt/logistics-secrets
install -o root -g logistics -m 0640 "$repo_dir/$postal_source_rel" "$postal_target"

runtime_password="$(openssl rand -hex 32)"
importer_password="$(openssl rand -hex 32)"
auth_secret="$(openssl rand -hex 32)"
mfa_key="$(openssl rand -base64 32)"
PGPASSWORD="$rds_master_password"
export PGPASSWORD
trap 'unset PGPASSWORD rds_master_password admin_password runtime_password importer_password' EXIT

if ! psql "host=$rds_host port=5432 dbname=postgres user=$rds_master_user sslmode=verify-full sslrootcert=/etc/ssl/certs/aws-rds-global-bundle.pem" \
  -tAc "SELECT 1 FROM pg_database WHERE datname='logistics'" | grep -q 1; then
  createdb "host=$rds_host port=5432 dbname=postgres user=$rds_master_user sslmode=verify-full sslrootcert=/etc/ssl/certs/aws-rds-global-bundle.pem" logistics
fi
psql "host=$rds_host port=5432 dbname=logistics user=$rds_master_user sslmode=verify-full sslrootcert=/etc/ssl/certs/aws-rds-global-bundle.pem" \
  -v ON_ERROR_STOP=1 -v runtime_password="$runtime_password" -v importer_password="$importer_password" <<'SQL'
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='logistics_postal_owner') THEN
    CREATE ROLE logistics_postal_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='logistics_app') THEN
    CREATE ROLE logistics_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='logistics_postal_importer') THEN
    CREATE ROLE logistics_postal_importer LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END $roles$;
ALTER ROLE logistics_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT;
ALTER ROLE logistics_postal_importer LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
ALTER ROLE logistics_app PASSWORD :'runtime_password';
ALTER ROLE logistics_postal_importer PASSWORD :'importer_password';
GRANT CONNECT, TEMPORARY, CREATE ON DATABASE logistics TO logistics_app;
GRANT CONNECT ON DATABASE logistics TO logistics_postal_importer;
SQL

temp_env="$(mktemp)"
cat >"$temp_env" <<EOF
NODE_ENV=production
APP_ENV=production
FRONTEND_URL='$public_origin'
BACKEND_URL='http://127.0.0.1:4000'
FRONTEND_PORT=3000
BACKEND_PORT=4000
DEFAULT_TENANT_TIMEZONE=Asia/Kolkata
SSL_CERT_FILE=/etc/ssl/certs/aws-rds-global-bundle.pem
DATABASE_URL='postgresql://logistics_app:$runtime_password@$rds_host:5432/logistics?schema=app&sslmode=require&sslcert=/etc/ssl/certs/aws-rds-global-bundle.pem&sslaccept=strict'
POSTAL_IMPORT_DATABASE_URL='postgresql://logistics_postal_importer:$importer_password@$rds_host:5432/logistics?schema=app&sslmode=require&sslcert=/etc/ssl/certs/aws-rds-global-bundle.pem&sslaccept=strict'
POSTAL_IMPORT_EXPECTED_DATABASE=logistics
POSTAL_DIRECTORY_FILE='$postal_target'
POSTAL_DIRECTORY_SHA256='$postal_sha256'
POSTAL_DIRECTORY_VERSION='ogd-2025-10-03'
POSTAL_DIRECTORY_SOURCE_NAME='India Post / OGD All India Pincode Directory'
POSTAL_DIRECTORY_SOURCE_URI='https://www.data.gov.in/resource/all-india-pincode-directory-till-last-month'
POSTAL_DIRECTORY_IMPORTED_BY='aws-first-setup'
AUTH_SECRET='$auth_secret'
PLATFORM_ADMIN_EMAIL='$admin_email'
PLATFORM_ADMIN_PASSWORD='$admin_password'
INVITATION_TTL_HOURS=72
SESSION_TTL_HOURS=24
ENABLE_TEST_HOOKS=false
MFA_ENCRYPTION_KEY='$mfa_key'
MFA_KEY_VERSION=1
SUPPORTED_COUNTRIES=AE,GB,IN,SG,US
SUPPORTED_CURRENCIES=AED,EUR,GBP,INR,SGD,USD
EOF
install -o root -g logistics -m 0640 "$temp_env" "$env_file"
rm -f "$temp_env"

sudo -u logistics "$repo_dir/scripts/validate-production-env.sh" "$env_file"
sudo -u logistics bash -lc "cd '$repo_dir' && corepack pnpm install --frozen-lockfile"
sudo -u logistics bash -lc "set -a; source '$env_file'; set +a; cd '$repo_dir'; corepack pnpm --filter @logistics/db run db:migrate"
psql "host=$rds_host port=5432 dbname=logistics user=$rds_master_user sslmode=verify-full sslrootcert=/etc/ssl/certs/aws-rds-global-bundle.pem" \
  -v ON_ERROR_STOP=1 -f "$repo_dir/scripts/sql/postal-ownership-handoff.sql"
unset PGPASSWORD rds_master_password

sudo -u logistics bash -lc "set -a; source '$env_file'; set +a; cd '$repo_dir'; corepack pnpm --filter @logistics/db run postal:verify-ownership; corepack pnpm --filter @logistics/db run postal:import -- --file \"\$POSTAL_DIRECTORY_FILE\" --version \"\$POSTAL_DIRECTORY_VERSION\" --sha256 \"\$POSTAL_DIRECTORY_SHA256\" --source-name \"\$POSTAL_DIRECTORY_SOURCE_NAME\" --source-uri \"\$POSTAL_DIRECTORY_SOURCE_URI\" --imported-by \"\$POSTAL_DIRECTORY_IMPORTED_BY\" --activate true; corepack pnpm run build; corepack pnpm run db:seed"

install -o root -g root -m 0644 "$repo_dir/deploy/aws/logistics-backend.service" /etc/systemd/system/logistics-backend.service
install -o root -g root -m 0644 "$repo_dir/deploy/aws/logistics-frontend.service" /etc/systemd/system/logistics-frontend.service
install -o root -g root -m 0644 "$repo_dir/deploy/aws/nginx.conf" /etc/nginx/sites-available/logistics-management
ln -sfn /etc/nginx/sites-available/logistics-management /etc/nginx/sites-enabled/logistics-management
rm -f /etc/nginx/sites-enabled/default
cat >/etc/sudoers.d/logistics-deploy <<'EOF'
logistics ALL=(root) NOPASSWD: /usr/bin/systemctl restart logistics-backend.service logistics-frontend.service, /usr/bin/systemctl is-active --quiet logistics-backend.service, /usr/bin/systemctl is-active --quiet logistics-frontend.service
EOF
chmod 0440 /etc/sudoers.d/logistics-deploy
visudo -cf /etc/sudoers.d/logistics-deploy
nginx -t
systemctl daemon-reload
systemctl enable --now nginx logistics-backend.service logistics-frontend.service

curl --fail --silent --show-error --retry 30 --retry-delay 2 --retry-connrefused \
  http://127.0.0.1:4000/api/v1/health/ready | jq
curl --fail --silent --show-error --output /dev/null \
  --write-out 'Public login page HTTP %{http_code}\n' "$public_origin/login"
printf 'First setup completed. Sign in as %s at %s/login.\n' "$admin_email" "$public_origin"
