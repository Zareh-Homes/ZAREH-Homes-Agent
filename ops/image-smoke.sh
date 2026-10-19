#!/usr/bin/env bash
# Builds-then-runs check for the two deployable images (CI job "images").
#
#   ops/image-smoke.sh zareh-api:ci zareh-web:ci
#
# Starts a TLS-only PostgreSQL 16, migrates it as the owner, creates the restricted
# application login, then runs the images the way production does and checks:
#   - the API image refuses to start with an unsafe production configuration
#   - with a proper configuration it starts as a non-root user, /healthz and /readyz pass
#     (readyz = connected as the restricted login, latest migration applied)
#   - a forged x-user-id header gets 401
#   - the web image serves the app with its security headers and proxies /healthz to the API
# Throwaway keys and passwords are generated here and never leave the runner.
set -euo pipefail
api_image=$1 web_image=$2
net=zh-smoke work=$(mktemp -d)
cleanup() {
  for c in zh-web zh-api zh-db; do docker logs "$c" > "$work/$c.log" 2>&1 || true; done
  if [[ ${ok:-0} != 1 ]]; then tail -n 40 "$work"/*.log || true; fi
  docker rm -f zh-web zh-api zh-db > /dev/null 2>&1 || true
  docker network rm "$net" > /dev/null 2>&1 || true
}
trap cleanup EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

# PostgreSQL that only accepts TLS connections from other hosts
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=zh-db -keyout "$work/server.key" -out "$work/server.crt" 2> /dev/null
cat > "$work/pg_hba.conf" <<'HBA'
local all all trust
hostssl all all all scram-sha-256
HBA
chmod 600 "$work/server.key"
sudo chown 999:999 "$work/server.key" "$work/server.crt" "$work/pg_hba.conf"
owner_pw=$(openssl rand -hex 16) app_pw=$(openssl rand -hex 16)
docker network create "$net" > /dev/null
docker run -d --name zh-db --network "$net" -p 5433:5432 -e POSTGRES_PASSWORD="$owner_pw" -v "$work:/certs:ro" postgres:16 \
  -c ssl=on -c ssl_cert_file=/certs/server.crt -c ssl_key_file=/certs/server.key -c hba_file=/certs/pg_hba.conf > /dev/null
owner_url="postgresql://postgres:$owner_pw@localhost:5433/postgres?sslmode=require"
for _ in $(seq 60); do psql "$owner_url" -XAtqc "select 1" > /dev/null 2>&1 && break; sleep 1; done
psql "$owner_url" -XAtqc "select 1" > /dev/null || fail "database didn't start"
[[ $(psql "postgresql://postgres:$owner_pw@localhost:5433/postgres?sslmode=disable" -XAtqc "select 1" 2>&1) == *"no pg_hba.conf entry"* ]] \
  || fail "database accepted a connection without TLS"

DATABASE_URL=$owner_url brokerage-db/migrate.sh > /dev/null
psql "$owner_url" -Xq -v ON_ERROR_STOP=1 -v pw="$app_pw" -f ops/create-app-login.sql

prod_env=(
  -e NODE_ENV=production
  -e "DATABASE_URL=postgresql://zareh_app_login:$app_pw@zh-db:5432/postgres?sslmode=require&sslaccept=accept_invalid_certs"
  -e APP_ORIGINS=https://backoffice.invalid -e TRUST_PROXY=true
  -e "FIELD_ENCRYPTION_KEY=$(openssl rand -base64 32)" -e "FILE_ENCRYPTION_KEY=$(openssl rand -base64 32)"
  -e "BROKERAGE_LEGAL_NAME=Smoke Test Brokerage" -e "BROKERAGE_ADDRESS=1 Test St" -e BROKERAGE_PHONE=000 -e BROKERAGE_EMAIL=smoke@invalid
  -e BROKERAGE_HST_NUMBER=000000000RT0001 -e "BROKER_OF_RECORD=Smoke Test"
)

# 1. Unsafe configuration: the container must exit without starting the server
if out=$(docker run --rm --network "$net" "${prod_env[@]}" -e ALLOW_DEV_AUTH_HEADER=true "$api_image" 2>&1); then
  fail "API image started with ALLOW_DEV_AUTH_HEADER set"
fi
[[ $out == *"NOT ready for production"* ]] || fail "unexpected refusal output: $out"
if docker run --rm --network "$net" "${prod_env[@]}" -e "DATABASE_URL=postgresql://postgres:$owner_pw@zh-db:5432/postgres?sslmode=require" "$api_image" > /dev/null 2>&1; then
  fail "API image started with the owner database login"
fi
echo "ok: unsafe configurations refused"

# 2. Proper configuration
docker run -d --name zh-api --network "$net" --network-alias api -p 3000:3000 "${prod_env[@]}" "$api_image" > /dev/null
for _ in $(seq 60); do curl -fsS localhost:3000/healthz > /dev/null 2>&1 && break; sleep 1; done
curl -fsS localhost:3000/healthz > /dev/null || fail "/healthz"
ready=$(curl -sS -o /dev/null -w '%{http_code}' localhost:3000/readyz)
[[ $ready == 200 ]] || fail "/readyz returned $ready: $(curl -sS localhost:3000/readyz)"
[[ $(docker exec zh-api id -u) == 10001 ]] || fail "API runs as root"
forged=$(curl -sS -o /dev/null -w '%{http_code}' -H "x-user-id: 00000000-0000-0000-0000-000000000001" localhost:3000/api/dashboard)
[[ $forged == 401 ]] || fail "forged x-user-id got $forged"
curl -sSI localhost:3000/healthz | grep -qi '^strict-transport-security:' || fail "API missing HSTS"
echo "ok: API healthy and ready as the restricted login, non-root, forged identity refused"

# 3. Web image
docker run -d --name zh-web --network "$net" -p 8080:8080 "$web_image" > /dev/null
for _ in $(seq 30); do curl -fsS localhost:8080/ > /dev/null 2>&1 && break; sleep 1; done
page=$(curl -fsS localhost:8080/) || fail "web app not served"
[[ $page == *'id="root"'* ]] || fail "index.html missing the app root"
headers=$(curl -sSI localhost:8080/)
for h in content-security-policy x-frame-options x-content-type-options referrer-policy; do
  grep -qi "^$h:" <<< "$headers" || fail "web missing $h"
done
curl -fsS localhost:8080/healthz > /dev/null || fail "web doesn't proxy /healthz to the API"
echo "ok: web app served with security headers, proxying to the API"
ok=1
