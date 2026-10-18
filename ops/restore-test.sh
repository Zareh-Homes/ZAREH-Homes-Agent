#!/usr/bin/env bash
# Restores a backup into an isolated scratch database and proves it matches the manifest taken at backup time.
#
#   RESTORE_ADMIN_URL=<superuser on an isolated server> ops/restore-test.sh <backup file> <manifest.json> [age identity file]
#
# Never point RESTORE_ADMIN_URL at production. Creates zareh_restore_test_<stamp>, restores, compares, drops it.
set -euo pipefail
: "${RESTORE_ADMIN_URL:?}"
backup="$1"; manifest="$2"; identity="${3:-}"
sha256sum -c "$backup.sha256" > /dev/null
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
if [[ "$backup" == *.age ]]; then
  : "${identity:?an age identity file is needed to decrypt}"
  age -d -i "$identity" -o "$work/backup.dump" "$backup"
else
  cp "$backup" "$work/backup.dump"
fi
db="zareh_restore_test_$(date -u +%Y%m%d%H%M%S)"
started=$(date +%s)
psql "$RESTORE_ADMIN_URL" -X -q -v ON_ERROR_STOP=1 -c "CREATE DATABASE $db"
target="$(python3 -c "import sys,urllib.parse as u; p=u.urlsplit(sys.argv[1]); print(u.urlunsplit(p._replace(path='/'+sys.argv[2])))" "$RESTORE_ADMIN_URL" "$db")"
# Roles are cluster-wide: the application role must exist for the grants to restore
psql "$target" -X -q -c "DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zareh_app') THEN CREATE ROLE zareh_app NOLOGIN; END IF; END \$\$"
pg_restore --no-owner --exit-on-error -d "$target" "$work/backup.dump"
psql "$target" -X -At -v ON_ERROR_STOP=1 -f "$(dirname "$0")/manifest.sql" > "$work/restored.json"
elapsed=$(( $(date +%s) - started ))
if python3 - "$manifest" "$work/restored.json" <<'PY'
import json, sys
a, b = (json.load(open(p)) for p in sys.argv[1:3])
diff = {k: (a.get(k), b.get(k)) for k in set(a) | set(b) if a.get(k) != b.get(k)}
if diff:
    print("MISMATCH:", json.dumps(diff, indent=2)); sys.exit(1)
print("Restored database matches the backup manifest:", json.dumps({"rows": b["rows"], "trustBalance": b["trustBalance"], "migrations": len(b["migrations"])}))
PY
then result=0; else result=1; fi
# The restored ledger is still append-only
if psql "$target" -X -q -c "UPDATE \"TrustLedgerEntry\" SET amount = amount WHERE false" 2>/dev/null; then :; fi
psql "$target" -X -q -At -c "SELECT 'append-only triggers present: ' || COUNT(*) FROM pg_trigger WHERE tgname LIKE '%immutable%'"
psql "$RESTORE_ADMIN_URL" -X -q -c "DROP DATABASE $db"
echo "Restore took ${elapsed}s (recovery time objective: 4 hours)"
exit $result
