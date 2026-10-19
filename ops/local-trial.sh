#!/usr/bin/env bash
# Try the back office on your own computer, free, with fictional data.
#
#   ops/local-trial.sh          start an empty brokerage (first run builds everything: a few minutes), print the first sign-in link
#   ops/local-trial.sh demo     start a demo brokerage already filled with fictional agents, deals, deposits, a CDA and payouts,
#                               then print a one-time sign-in link for each demo person (erases any earlier trial data)
#   ops/local-trial.sh stop     stop it (your test data is kept)
#   ops/local-trial.sh reset    stop and erase all test data
#
# Needs Docker Desktop (Mac or Windows) or Docker Engine (Linux). Opens on http://localhost:8080 with the real
# sign-in, two-factor and permissions; only the https part of a hosted setup is missing. Nothing here connects
# to a bank, an accounting system or a regulator. Never enter real client information.
set -euo pipefail
cd "$(dirname "$0")/.."
MODE="${1:-start}"
case "$MODE" in
  stop) docker compose stop; exit 0 ;;
  reset) docker compose down -v; rm -f .env; echo "Erased."; exit 0 ;;
  start|demo) ;;
  *) echo "usage: ops/local-trial.sh [start|demo|stop|reset]" >&2; exit 2 ;;
esac
command -v docker > /dev/null || { echo "Install Docker Desktop first: https://www.docker.com/products/docker-desktop/" >&2; exit 1; }

if [[ -f .env ]] && ! grep -q '^# local-trial' .env; then
  echo "A .env file already exists and wasn't made by this script; move it aside first." >&2; exit 1
fi

if [[ $MODE == demo ]]; then
  if [[ -f .env && "${2:-}" != "--yes" ]]; then
    read -r -p "The demo starts from scratch and erases your current trial data. Continue? [y/N] " ok
    [[ $ok == [yY]* ]] || exit 1
  fi
  docker compose down -v > /dev/null 2>&1 || true
  rm -f .env
fi

if [[ ! -f .env ]]; then
  rnd() { openssl rand -hex 16; }
  key() { openssl rand -base64 32; }
  # The demo's scripted browser reaches the app as http://web:8080 inside Docker
  # and does a brokerage month in minutes, above the default per-address request limit (sign-in limits unchanged)
  origins="http://localhost:8080"; api_limit=600
  [[ $MODE == demo ]] && { origins="$origins,http://web:8080"; api_limit=5000; }
  cat > .env <<ENV
# local-trial: made by ops/local-trial.sh for a fictional-data trial on this computer. Keep it private.
POSTGRES_PASSWORD=$(rnd)
APP_DB_PASSWORD=$(rnd)
NODE_ENV=development
APP_ORIGINS=$origins
COOKIE_SECURE=false
API_REQUESTS_PER_MINUTE=$api_limit
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

if ! docker compose up --build -d; then
  docker compose logs --tail 60 migrate db
  echo "Starting failed; the log above says why." >&2
  exit 1
fi
echo "Waiting for the app to start..."
for _ in $(seq 120); do curl -fsS http://localhost:8080/readyz > /dev/null 2>&1 && break; sleep 2; done
curl -fsS http://localhost:8080/readyz > /dev/null || { docker compose logs --tail 40 api; echo "The app didn't start." >&2; exit 1; }

if [[ $MODE == start ]]; then
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
  exit 0
fi

# Demo: the browser test journey fills the brokerage through the real screens (every rule, approval and
# separation of duties applies), then each demo person is handed over with a fresh link.
mkdir -p e2e/.state && rm -rf e2e/.state/*
docker compose exec -T api node scripts/create-first-admin.ts --email admin@e2e.test --first Avery --last Admin \
  --app-url http://localhost:8080 | tail -1 > e2e/.state/admin-invite
network=$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}' "$(docker compose ps -q web)")
echo "Filling the demo brokerage through the screens (about 5 minutes)..."
if ! docker run --rm --network "$network" -v "$PWD/e2e:/e2e" -v zareh-demo-e2e-modules:/e2e/node_modules -w /e2e \
    -e E2E_BASE_URL=http://web:8080 -e CI=1 mcr.microsoft.com/playwright:v1.56.1-noble \
    bash -c "npm ci --no-audit --no-fund --loglevel=error && npx playwright test --reporter=line"; then
  echo "Filling the demo failed; the report is in e2e/report (open e2e/report/index.html)." >&2
  exit 1
fi

echo
echo "Demo brokerage ready at http://localhost:8080 (fictional data only)."
echo "Open each link once to choose that person's password; staff roles then set up two-factor with your phone."
echo "Use a separate browser profile or private window per person. Links work once, for 72 hours."
echo
docker compose exec -T api node scripts/demo-handover.ts --app-url http://localhost:8080
echo
echo "Walkthrough: docs/demo-walkthrough.md. Stop with: ops/local-trial.sh stop"
