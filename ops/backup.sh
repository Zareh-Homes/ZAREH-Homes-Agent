#!/usr/bin/env bash
# Encrypted, verified database backup.
#
#   DATABASE_URL=<owner or backup role> BACKUP_DIR=/secure/backups BACKUP_RECIPIENT=<age public key> ops/backup.sh
#
# Writes <stamp>.dump.age (pg_dump custom format, encrypted to the recipient's public key with `age`)
# and <stamp>.manifest.json (row counts and trust totals at backup time, used by restore-test.sh).
# The private key that decrypts backups is kept offline by the broker of record, never on the server.
# Without BACKUP_RECIPIENT it refuses to write an unencrypted file unless ALLOW_UNENCRYPTED_BACKUP=1
# (isolated test environments only).
set -euo pipefail
: "${DATABASE_URL:?}"; : "${BACKUP_DIR:?}"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BACKUP_DIR"
umask 077
dump="$BACKUP_DIR/$stamp.dump"
pg_dump "$DATABASE_URL" -Fc --no-owner -f "$dump"
pg_restore --list "$dump" > /dev/null # the archive is readable

# What the restore must reproduce
psql "$DATABASE_URL" -X -At -v ON_ERROR_STOP=1 -f "$(dirname "$0")/manifest.sql" > "$BACKUP_DIR/$stamp.manifest.json"

if [[ -n "${BACKUP_RECIPIENT:-}" ]]; then
  age -r "$BACKUP_RECIPIENT" -o "$dump.age" "$dump"
  rm -f "$dump"
  out="$dump.age"
elif [[ "${ALLOW_UNENCRYPTED_BACKUP:-}" == "1" ]]; then
  out="$dump"
else
  rm -f "$dump"
  echo "REFUSED: set BACKUP_RECIPIENT (age public key); backups hold personal and trust data" >&2
  exit 2
fi
sha256sum "$out" > "$out.sha256"
echo "$out"
