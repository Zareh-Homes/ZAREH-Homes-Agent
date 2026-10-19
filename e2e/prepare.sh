#!/usr/bin/env bash
# Fresh database for one run: drop and recreate E2E_DATABASE, apply every
# migration with the repository's runner, build the web app, and create the
# first admin's invitation (the only account the tests don't make through the UI).
#
#   E2E_ADMIN_URL=postgresql://owner@host/postgres  (any database on the server; used to drop/create)
#   E2E_DATABASE=zareh_e2e
set -euo pipefail
cd "$(dirname "$0")"
REPO="$(cd .. && pwd)"
: "${E2E_ADMIN_URL:?set E2E_ADMIN_URL to an owner connection on the test PostgreSQL server}"
DB="${E2E_DATABASE:-zareh_e2e}"
[[ "$DB" =~ ^[a-z0-9_]+$ ]] || { echo "E2E_DATABASE must be a simple name" >&2; exit 2; }
[[ "$DB" == *e2e* ]] || { echo "Refusing: E2E_DATABASE must contain 'e2e' (this drops it)" >&2; exit 2; }

psql "$E2E_ADMIN_URL" -X -q -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS $DB WITH (FORCE)" -c "CREATE DATABASE $DB"
DB_URL="$(node -e 'const u=new URL(process.argv[1]); u.pathname="/"+process.argv[2]; console.log(u.toString())' "$E2E_ADMIN_URL" "$DB")"
DATABASE_URL="$DB_URL" "$REPO/brokerage-db/migrate.sh" | tail -1

mkdir -p .state && rm -rf .state/* && echo "$DB_URL" > .state/database-url
(cd "$REPO/backend" && DATABASE_URL="$DB_URL" node scripts/create-first-admin.ts \
  --email admin@e2e.test --first Avery --last Admin --app-url http://127.0.0.1:4173) | tail -1 > .state/admin-invite
(cd "$REPO/frontend" && npx vite build --logLevel warn)
echo "prepared $DB"
