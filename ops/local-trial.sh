#!/usr/bin/env bash
# Try the back office on your own computer, free, with fictional data.
#
#   ops/local-trial.sh          start (first run builds everything: a few minutes), print the first sign-in link
#   ops/local-trial.sh stop     stop it (your test data is kept)
#   ops/local-trial.sh reset    stop and erase all test data
#
# Needs Docker Desktop (Mac or Windows) or Docker Engine (Linux). Opens on http://localhost:8080 with the real
# sign-in, two-factor and permissions; only the https part of a hosted setup is missing. Nothing here connects
# to a bank, an accounting system or a regulator. Never enter real client information.
set -euo pipefail
cd "$(dirname "$0")/.."
case "${1:-start}" in
  stop) docker compose stop; exit 0 ;;
  reset) docker compose down -v; rm -f .env; echo "Erased."; exit 0 ;;
  start) ;;
  *) echo "usage: ops/local-trial.sh [start|stop|reset]" >&2; exit 2 ;;
esac
command -v docker > /dev/null || { echo "Install Docker Desktop first: https://www.docker.com/products/docker-desktop/" >&2; exit 1; }

if [[ -f .env ]] && ! grep -q '^# local-trial' .env; then
  echo "A .env file already exists and wasn't made by this script; move it aside first." >&2; exit 1
fi
if [[ ! -f .env ]]; then
  rnd() { openssl rand -hex 16; }
  key() { openssl rand -base64 32; }
  cat > .env <<ENV
# local-trial: made by ops/local-trial.sh for a fictional-data trial on this computer. Keep it private.
POSTGRES_PASSWORD=$(rnd)
APP_DB_PASSWORD=$(rnd)
NODE_ENV=development
APP_ORIGINS=http://localhost:8080
COOKIE_SECURE=false
FIELD_ENCRYPTION_KEY=$(key)
FILE_ENCRYPTION_KEY=$(key)
BROKERAGE_LEGAL_NAME=Trial Brokerage (fictional)
BROKERAGE_ADDRESS=1 Example St, Hamilton ON
BROKERAGE_PHONE=905-555-0100
BROKERAGE_EMAIL=trial@example.test
BROKERAGE_HST_NUMBER=000000000RT0001
BROKER_OF_RECORD=Trial Broker of Record
ENV
fi

docker compose up --build -d
echo "Waiting for the app to start..."
for _ in $(seq 120); do curl -fsS http://localhost:8080/readyz > /dev/null 2>&1 && break; sleep 2; done
curl -fsS http://localhost:8080/readyz > /dev/null || { docker compose logs --tail 40 api; echo "The app didn't start." >&2; exit 1; }

email="${TRIAL_ADMIN_EMAIL:-admin@trial.test}"
link=$(docker compose exec -T api node scripts/create-first-admin.ts --email "$email" --first Trial --last Admin \
  --app-url http://localhost:8080 2>&1 | tail -1) || true
echo
if [[ $link == http* ]]; then
  echo "Open this link to set the admin password (works once, 72 hours):"
  echo "  $link"
else
  echo "The admin is already set up. Open http://localhost:8080 and sign in."
fi
echo
echo "Then follow docs/pilot-test-checklist.md. Stop with: ops/local-trial.sh stop"
