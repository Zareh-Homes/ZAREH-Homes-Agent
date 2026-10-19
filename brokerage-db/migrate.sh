#!/usr/bin/env bash
# Applies brokerage-db/migrations/*.sql in order, once each, and records them in zareh_meta.schema_migrations.
#
#   DATABASE_URL=postgresql://owner@host/db brokerage-db/migrate.sh [--status] [--backup-dir DIR]
#
# Run as the schema owner (never as the application's zareh_app login).
#   • Each file's SHA-256 is recorded in schema_migrations; if an applied file has
#     since changed, nothing runs: applied migrations are never edited.
#   • Files run in order with ON_ERROR_STOP; a failure stops the run. Files carry
#     their own BEGIN/COMMIT (enum additions sit before BEGIN), so a failed file
#     rolls back its own transaction.
#   • With --backup-dir, a pg_dump is taken before the first pending migration:
#     rollback is restoring that backup (migrations are forward-only).
set -euo pipefail
export PGOPTIONS="${PGOPTIONS:-} -c client_min_messages=warning"

DIR="$(cd "$(dirname "$0")/migrations" && pwd)"
: "${DATABASE_URL:?set DATABASE_URL to the owner connection}"
MODE=apply
BACKUP_DIR=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --status) MODE=status; shift ;;
    --backup-dir) BACKUP_DIR="$2"; shift 2 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done

psqlq() { psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 "$@"; }
psqlq -c 'CREATE SCHEMA IF NOT EXISTS zareh_meta; CREATE TABLE IF NOT EXISTS zareh_meta.schema_migrations (
  filename TEXT PRIMARY KEY, sha256 TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), applied_by TEXT NOT NULL DEFAULT current_user)'

pending=()
# Byte order, whatever the operator's locale: en_US would sort 001a_ before 001_
for f in $(ls "$DIR"/*.sql | LC_ALL=C sort); do
  name="$(basename "$f")"
  sum="$(sha256sum "$f" | cut -d' ' -f1)"
  recorded="$(psqlq -At -c "SELECT sha256 FROM zareh_meta.schema_migrations WHERE filename = '$name'")"
  if [[ -n "$recorded" ]]; then
    if [[ "$recorded" != "$sum" ]]; then
      echo "REFUSED: $name was changed after it was applied (recorded $recorded, now $sum). Write a new migration instead." >&2
      exit 3
    fi
    [[ "$MODE" == status ]] && echo "applied  $name"
  else
    pending+=("$f")
    [[ "$MODE" == status ]] && echo "pending  $name"
  fi
done
[[ "$MODE" == status ]] && exit 0
if [[ ${#pending[@]} -eq 0 ]]; then echo "Up to date."; exit 0; fi

if [[ -n "$BACKUP_DIR" ]]; then
  mkdir -p "$BACKUP_DIR"
  out="$BACKUP_DIR/pre-migration-$(date -u +%Y%m%dT%H%M%SZ).dump"
  pg_dump "$DATABASE_URL" -Fc -f "$out"
  sha256sum "$out" > "$out.sha256"
  echo "Backup before migrating: $out"
fi

for f in "${pending[@]}"; do
  name="$(basename "$f")"
  echo "applying $name"
  psqlq -f "$f"
  psqlq -c "INSERT INTO zareh_meta.schema_migrations (filename, sha256) VALUES ('$name', '$(sha256sum "$f" | cut -d' ' -f1)')"
done
# The application may read (only) which migrations are applied, for its readiness check
psqlq -c "DO \$\$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zareh_app') THEN
  GRANT USAGE ON SCHEMA zareh_meta TO zareh_app; GRANT SELECT ON zareh_meta.schema_migrations TO zareh_app; END IF; END \$\$"
echo "Applied ${#pending[@]} migration(s)."
