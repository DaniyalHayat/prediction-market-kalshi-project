#!/usr/bin/env bash
set -euo pipefail
export MSYS_NO_PATHCONV=1

image=${1:-predictir-azure-bootstrap:ci}
fixture="predictir-bootstrap-test-$$"
database_image=${2:-postgres:17-alpine@sha256:266d3c257594e195b309ae9d1805e54c788f1d7b375f56bf6c367aac6c917e7b}
host=fixture.postgres.database.azure.com
certs=$(mktemp -d)
cleanup() {
  docker rm -f "$fixture" >/dev/null 2>&1 || true
  docker network rm "$fixture" >/dev/null 2>&1 || true
  rm -f "$certs/server.crt" "$certs/server.key"
  rmdir "$certs"
}
trap cleanup EXIT

(
  cd "$certs"
  openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=$host" -addext "subjectAltName=DNS:$host" \
    -keyout server.key -out server.crt 2>/dev/null
)
docker network create --internal "$fixture" >/dev/null
docker run --detach --name "$fixture" --network "$fixture" --network-alias "$host" \
  --network-alias wrong.postgres.database.azure.com --env POSTGRES_PASSWORD=disposable_test_only "$database_image" >/dev/null
for attempt in {1..30}; do
  if docker exec "$fixture" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done

tar -C "$certs" -cf - server.crt server.key | docker cp - "$fixture:/tmp"
docker exec --user root "$fixture" sh -c 'chown postgres:postgres /tmp/server.crt /tmp/server.key && chmod 600 /tmp/server.key'
docker exec --interactive --user postgres "$fixture" psql -Xq -U postgres -d postgres -v ON_ERROR_STOP=1 <<'SQL'
CREATE ROLE predictir_admin LOGIN CREATEROLE CREATEDB PASSWORD 'fixture-admin-not-a-real-secret';
CREATE DATABASE predictir OWNER predictir_admin;
ALTER SYSTEM SET ssl = 'on';
ALTER SYSTEM SET ssl_cert_file = '/tmp/server.crt';
ALTER SYSTEM SET ssl_key_file = '/tmp/server.key';
SELECT pg_reload_conf();
SQL

export DATABASE_CA_CERT
DATABASE_CA_CERT=$(cat "$certs/server.crt")
export POSTGRES_ADMIN_PASSWORD='fixture-admin-not-a-real-secret'
export DATABASE_URL="postgresql://market_lab_app:fixture_app_password_not_a_secret_1@$host:5432/predictir"
bootstrap() {
  docker run --rm --network "$fixture" --env DATABASE_CA_CERT --env POSTGRES_ADMIN_PASSWORD --env DATABASE_URL \
    --env "PREDICTIR_DATABASE_HOST=$1" "$image"
}

bootstrap "$host"
bootstrap "$host"
if DATABASE_URL="postgresql://market_lab_app:fixture_app_password_not_a_secret_1@wrong.postgres.database.azure.com:5432/predictir" \
  bootstrap wrong.postgres.database.azure.com; then
  printf 'Bootstrap accepted a mismatched TLS hostname.\n' >&2
  exit 1
fi
if DATABASE_URL="postgresql://predictir_admin:fixture_app_password_not_a_secret_1@$host:5432/predictir" bootstrap "$host"; then
  printf 'Bootstrap accepted the admin role as the application login.\n' >&2
  exit 1
fi

leftovers=$(docker exec --user postgres "$fixture" psql -XAt -U postgres -d predictir -v ON_ERROR_STOP=1 \
  -c 'SELECT (SELECT count(*) FROM market_lab.owner_portfolios)+(SELECT count(*) FROM market_lab.records)+(SELECT count(*) FROM market_lab.jobs)+(SELECT count(*) FROM market_lab.archives)')
[[ $leftovers == 0 ]]
printf 'Verified two TLS bootstrap runs, restricted grants, two negative controls and rollback of probe rows.\n'
