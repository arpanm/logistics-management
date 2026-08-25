#!/usr/bin/env bash
set -euo pipefail

env_file="${1:-/etc/logistics-management.env}"

[[ -r "$env_file" ]] || {
  echo "Production environment file is missing or unreadable: $env_file" >&2
  exit 1
}

line_number=0
while IFS= read -r raw_line || [[ -n "$raw_line" ]]; do
  line_number=$((line_number + 1))
  line="${raw_line%$'\r'}"
  [[ -z "${line//[[:space:]]/}" || "$line" =~ ^[[:space:]]*# ]] && continue
  if ! printf '%s\n' "$line" | grep -Eq "^[A-Za-z_][A-Za-z0-9_]*=('([^']*)'|[A-Za-z0-9_.,:/?@%+\&=-]+)$"; then
    echo "Invalid environment syntax at $env_file:$line_number." >&2
    echo "Use NAME=value or NAME='value with spaces'; comments must start with # (not :#)." >&2
    exit 1
  fi
done <"$env_file"

set -a
# shellcheck disable=SC1090
source "$env_file"
set +a

required=(
  APP_ENV FRONTEND_URL BACKEND_URL SSL_CERT_FILE DATABASE_URL POSTAL_IMPORT_DATABASE_URL
  POSTAL_IMPORT_EXPECTED_DATABASE AUTH_SECRET MFA_ENCRYPTION_KEY
  PLATFORM_ADMIN_EMAIL PLATFORM_ADMIN_PASSWORD
)
for variable_name in "${required[@]}"; do
  if [[ -z "${!variable_name:-}" ]]; then
    echo "$variable_name is required in $env_file." >&2
    exit 1
  fi
done

[[ "$APP_ENV" == "production" ]] || {
  echo "APP_ENV must be production." >&2
  exit 1
}

[[ "$SSL_CERT_FILE" == /* ]] || {
  echo "SSL_CERT_FILE must be an absolute filesystem path." >&2
  exit 1
}
[[ -r "$SSL_CERT_FILE" ]] || {
  echo "SSL_CERT_FILE is missing or unreadable: $SSL_CERT_FILE" >&2
  exit 1
}

validate_rds_url() {
  local variable_name="$1"
  local expected_user="$2"
  local value="${!variable_name}"
  local ssl_server_cert
  case "$value" in
    *127.0.0.1*|*localhost*|*RDS_ENDPOINT*|*REPLACE_*)
      echo "$variable_name still contains a local host or placeholder; use the private RDS endpoint." >&2
      exit 1
      ;;
  esac
  [[ "$value" == postgresql://"$expected_user":* ]] || {
    echo "$variable_name must use PostgreSQL user $expected_user." >&2
    exit 1
  }
  [[ "$value" == *".rds.amazonaws.com:5432/logistics?"* ]] || {
    echo "$variable_name must target the RDS endpoint, port 5432, and database logistics." >&2
    exit 1
  }
  [[ "$value" == *"sslmode=require"* ]] || {
    echo "$variable_name must include sslmode=require for Prisma." >&2
    exit 1
  }
  [[ "$value" == *"sslcert="* ]] || {
    echo "$variable_name must include Prisma sslcert with the installed RDS CA bundle path." >&2
    exit 1
  }
  ssl_server_cert="${value#*sslcert=}"
  ssl_server_cert="${ssl_server_cert%%&*}"
  [[ "$ssl_server_cert" == /* ]] || {
    echo "$variable_name sslcert must be an absolute filesystem path." >&2
    exit 1
  }
  [[ -r "$ssl_server_cert" ]] || {
    echo "$variable_name sslcert is missing or unreadable: $ssl_server_cert" >&2
    echo "Install the AWS RDS CA bundle with read permission for the logistics user." >&2
    exit 1
  }
  [[ "$value" == *"sslaccept=strict"* ]] || {
    echo "$variable_name must include sslaccept=strict for certificate validation." >&2
    exit 1
  }
}

validate_rds_url DATABASE_URL logistics_app
validate_rds_url POSTAL_IMPORT_DATABASE_URL logistics_postal_importer

if [[ "$DATABASE_URL" == "$POSTAL_IMPORT_DATABASE_URL" ]]; then
  echo "Runtime and postal-import database URLs must use different credentials." >&2
  exit 1
fi

echo "Production environment preflight passed: RDS endpoint/TLS settings and shell syntax are valid."
