#!/bin/bash
set -euo pipefail

fail() { printf 'Predictir database bootstrap failed at %s.\n' "$1" >&2; exit 1; }

[[ ${PREDICTIR_DATABASE_HOST:-} =~ ^[a-z][a-z0-9-]+\.postgres\.database\.azure\.com$ ]] || fail 'host validation'
[[ ${#POSTGRES_ADMIN_PASSWORD} -ge 24 && -n ${DATABASE_CA_CERT:-} ]] || fail 'secret validation'

export PGHOST="$PREDICTIR_DATABASE_HOST" PGPORT=5432 PGDATABASE=predictir
export PGSSLMODE=verify-full PGCONNECT_TIMEOUT=12
export PGOPTIONS='-c statement_timeout=45000 -c lock_timeout=5000 -c application_name=predictir_azure_bootstrap'
app_prefix='postgresql://market_lab_app:'
app_suffix="@$PGHOST:5432/$PGDATABASE"
app_password=${DATABASE_URL#"$app_prefix"}
app_password=${app_password%"$app_suffix"}
[[ $app_password =~ ^[A-Za-z0-9_-]{32,128}$ &&
   $DATABASE_URL == "$app_prefix$app_password$app_suffix" ]] || fail 'app connection validation'

umask 077
PGSSLROOTCERT=$(mktemp)
export PGSSLROOTCERT
trap 'rm -f "$PGSSLROOTCERT"' EXIT
printf '%s\n' "$DATABASE_CA_CERT" > "$PGSSLROOTCERT"

export PGUSER=predictir_admin PGPASSWORD="$POSTGRES_ADMIN_PASSWORD"
unset POSTGRES_ADMIN_PASSWORD DATABASE_URL DATABASE_CA_CERT
[[ $(psql -XAt -v ON_ERROR_STOP=1 -c "SELECT current_database() = 'predictir' AND current_user = 'predictir_admin' AND current_setting('server_version_num')::integer BETWEEN 170000 AND 179999 AND (SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid())" 2>/dev/null) == t ]] ||
  fail 'verified PostgreSQL 17 admin connection'

psql -Xq -v ON_ERROR_STOP=1 -f apply.sql >/dev/null 2>&1 || fail 'schema and role setup'
printf '%s\n%s\n' "$app_password" "$app_password" |
  psql -Xq -v ON_ERROR_STOP=1 -c '\password market_lab_app' >/dev/null 2>&1 || fail 'runtime password setup'

export PGUSER=market_lab_app PGPASSWORD="$app_password"
unset app_password
psql -Xq -v ON_ERROR_STOP=1 -f verify.sql >/dev/null 2>&1 || fail 'runtime TLS and grants verification'
printf 'Predictir PostgreSQL 17 schema, runtime credentials and grants verified.\n'
