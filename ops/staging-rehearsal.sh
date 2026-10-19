#!/usr/bin/env bash
# Staging rehearsal (CI job "staging"): the production images deployed the way a staging host runs
# them, then the whole browser suite against it, then the deployment checks.
#
#   ops/staging-rehearsal.sh zareh-api:ci zareh-web:ci
#
#   database   PostgreSQL 16 accepting TLS only; migrated by the owner; the API uses the restricted login
#   API        NODE_ENV=production, secure cookies, CSRF origin, MFA, encryption keys, non-root
#   web        the nginx image, behind an HTTPS proxy (self-signed here; a real certificate on the host)
#   browser    every e2e test, over https://localhost:8443
#   after      session cookie flags and HSTS (e2e 08), the restricted login can't alter the ledger or the
#              audit log, no password / authenticator secret / ID number in the API logs or stored in
#              clear, the audit log has the sign-ins, and an encrypted backup restores and matches.
#
# Synthetic data only, throwaway keys generated here. It is not a substitute for checking the real host.
set -euo pipefail
api_image=$1 web_image=$2
repo=$(cd "$(dirname "$0")/.." && pwd)
net=zh-stg work=$(mktemp -d)
cleanup() {
  for c in zh-tls zh-web zh-api zh-db; do docker logs "$c" > "$work/$c.log" 2>&1 || true; done
  mkdir -p "$repo/e2e/report" && cp "$work"/*.log "$repo/e2e/report/" 2> /dev/null || true
  if [[ ${ok:-0} != 1 ]]; then tail -n 30 "$work"/zh-api.log || true; fi
  docker rm -f zh-tls zh-web zh-api zh-db > /dev/null 2>&1 || true
  docker network rm "$net" > /dev/null 2>&1 || true
}
trap cleanup EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
step() { echo "== $*"; }

step "database: TLS only, migrated by the owner, restricted application login"
certs="$work/certs"; mkdir -m 755 "$certs"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=zh-db -keyout "$certs/server.key" -out "$certs/server.crt" 2> /dev/null
printf 'local all all trust\nhostssl all all all scram-sha-256\n' > "$certs/pg_hba.conf"
chmod 600 "$certs/server.key"; chmod 644 "$certs/server.crt" "$certs/pg_hba.conf"
sudo chown 999:999 "$certs"/*
owner_pw=$(openssl rand -hex 16) app_pw=$(openssl rand -hex 16)
docker network create "$net" > /dev/null
docker run -d --name zh-db --network "$net" -p 5434:5432 -e POSTGRES_PASSWORD="$owner_pw" -v "$certs:/certs:ro" postgres:16 \
  -c ssl=on -c ssl_cert_file=/certs/server.crt -c ssl_key_file=/certs/server.key -c hba_file=/certs/pg_hba.conf > /dev/null
owner_url="postgresql://postgres:$owner_pw@localhost:5434/postgres?sslmode=require"
app_url_host="postgresql://zareh_app_login:$app_pw@localhost:5434/postgres?sslmode=require"
for _ in $(seq 60); do psql "$owner_url" -XAtqc "select 1" > /dev/null 2>&1 && break; sleep 1; done
DATABASE_URL=$owner_url brokerage-db/migrate.sh > /dev/null
psql "$owner_url" -Xq -v ON_ERROR_STOP=1 -v pw="$app_pw" -f ops/create-app-login.sql

prod_env=(
  -e NODE_ENV=production
  -e "DATABASE_URL=postgresql://zareh_app_login:$app_pw@zh-db:5432/postgres?sslmode=require&sslaccept=accept_invalid_certs"
  -e APP_ORIGINS=https://localhost:8443 -e TRUST_PROXY=true
  -e "FIELD_ENCRYPTION_KEY=$(openssl rand -base64 32)" -e "FILE_ENCRYPTION_KEY=$(openssl rand -base64 32)"
  -e "BROKERAGE_LEGAL_NAME=E2E Test Brokerage Inc. (not a real brokerage)" -e "BROKERAGE_ADDRESS=1 Test Street, Testville ON"
  -e BROKERAGE_PHONE=000-000-0000 -e BROKERAGE_EMAIL=office@e2e.test -e BROKERAGE_HST_NUMBER=TEST-ONLY -e "BROKER_OF_RECORD=Blake Broker (test)"
)

step "first admin, created with the script shipped in the API image"
mkdir -p "$repo/e2e/.state" && rm -rf "$repo/e2e/.state"/*
docker run --rm --network "$net" "${prod_env[@]}" "$api_image" \
  node scripts/create-first-admin.ts --email admin@e2e.test --first Avery --last Admin --app-url https://localhost:8443 \
  | tail -1 > "$repo/e2e/.state/admin-invite"
grep -q '^https://localhost:8443/accept-invite#token=' "$repo/e2e/.state/admin-invite" || fail "no invitation link"

step "API, web and the HTTPS front"
docker run -d --name zh-api --network "$net" --network-alias api "${prod_env[@]}" "$api_image" > /dev/null
docker run -d --name zh-web --network "$net" "$web_image" > /dev/null
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=localhost -keyout "$certs/tls.key" -out "$certs/tls.crt" 2> /dev/null
sudo chmod 644 "$certs/tls.key" "$certs/tls.crt"
cat > "$certs/tls.conf" <<'CONF'
server {
  listen 8443 ssl;
  server_tokens off;
  ssl_certificate /certs/tls.crt;
  ssl_certificate_key /certs/tls.key;
  ssl_protocols TLSv1.2 TLSv1.3;
  client_max_body_size 26m;
  add_header Strict-Transport-Security "max-age=31536000" always;
  location / { proxy_pass http://zh-web:8080; proxy_set_header Host $host; proxy_set_header X-Forwarded-For $remote_addr; proxy_set_header X-Forwarded-Proto https; }
}
server { listen 8080; return 301 https://$host:8443$request_uri; }
CONF
docker run -d --name zh-tls --network "$net" -p 8443:8443 -p 8081:8080 -v "$certs:/certs:ro" \
  -v "$certs/tls.conf:/etc/nginx/conf.d/default.conf:ro" nginx:1.30.5-alpine > /dev/null
for _ in $(seq 60); do curl -kfsS https://localhost:8443/readyz > /dev/null 2>&1 && break; sleep 1; done
curl -kfsS https://localhost:8443/readyz > /dev/null || fail "/readyz over https: $(curl -ksS https://localhost:8443/readyz)"
[[ $(curl -sS -o /dev/null -w '%{http_code}' http://localhost:8081/) == 301 ]] || fail "plain http isn't redirected to https"
[[ $(docker exec zh-api id -u) == 10001 ]] || fail "API runs as root"

step "browser suite over https"
(cd "$repo/e2e" && E2E_BASE_URL=https://localhost:8443 npx playwright test)

step "deployment checks"
# The restricted login can't rewrite history
for sql in "UPDATE \"TrustLedgerEntry\" SET memo = 'x'" "DELETE FROM \"AuditLog\"" "DELETE FROM \"TrustLedgerEntry\"" "DROP TABLE \"Transaction\""; do
  if psql "$app_url_host" -XAtqc "$sql" > /dev/null 2>&1; then fail "the application login could run: $sql"; fi
done
[[ $(psql "$app_url_host" -XAtqc 'SELECT count(*) FROM "TrustLedgerEntry"') -gt 0 ]] || fail "no ledger entries after the suite"
# Nothing secret in the logs, nothing sensitive stored in clear
docker logs zh-api > "$work/api-full.log" 2>&1
secrets=$(node -e '
  const p = require(process.argv[1]);
  const out = ["R1234-56789-01234"];
  for (const v of Object.values(p)) { out.push(v.password); if (v.secret) out.push(v.secret); for (const c of v.recovery ?? []) out.push(c); }
  console.log(out.join("\n"));' "$repo/e2e/.state/people.json")
while IFS= read -r s; do
  [[ -n $s ]] && grep -qF -- "$s" "$work/api-full.log" && fail "a password, authenticator secret, recovery code or ID number appears in the API log"
done <<< "$secrets"
grep -q '"url":"/api/auth/login"' "$work/api-full.log" || fail "the API log has no request records"
[[ $(psql "$owner_url" -XAtqc "SELECT count(*) FROM \"DocumentFile\" WHERE metadata::text LIKE '%R1234-56789-01234%'") == 0 ]] || fail "an ID number is stored in clear"
[[ $(psql "$owner_url" -XAtqc "SELECT count(*) FROM \"AuditLog\" WHERE action = 'LOGIN' AND outcome = 'SUCCESS'") -gt 0 ]] || fail "sign-ins aren't audited"
[[ $(psql "$owner_url" -XAtqc "SELECT count(*) FROM \"AuditLog\" WHERE action = 'LOGIN_FAILED'") -gt 0 ]] || fail "failed sign-ins aren't audited"
echo "ok: restricted login, logs, encryption at rest, audit"

step "encrypted backup, restored into a scratch database and compared"
age-keygen -o "$work/key.txt" 2> /dev/null
pub=$(grep "public key" "$work/key.txt" | awk '{print $4}')
out=$(DATABASE_URL=$owner_url BACKUP_DIR="$work/backups" BACKUP_RECIPIENT=$pub ops/backup.sh)
RESTORE_ADMIN_URL=$owner_url ops/restore-test.sh "$out" "${out%.dump.age}.manifest.json" "$work/key.txt"
ok=1
echo "ok: staging rehearsal passed"
