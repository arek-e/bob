#!/bin/sh
set -eu

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${RESTIC_REPOSITORY:?RESTIC_REPOSITORY is required}"
: "${RESTIC_PASSWORD_FILE:?RESTIC_PASSWORD_FILE is required}"

work="$(mktemp -d)"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"

# A new Runtime Cluster has an empty, dedicated backup bucket. Initialize its
# Restic repository before the first snapshot. Restic refuses to initialize an
# existing repository, so a failed config read cannot overwrite backup data.
if ! restic cat config >/dev/null 2>&1; then
  restic init
fi

pg_dump --dbname "$DATABASE_URL" --format=custom --no-owner --file "$work/database.dump"
pg_restore --list "$work/database.dump" >/dev/null

if [ -d "${OBJECT_STORAGE_DIRECTORY:-/data/object-storage}" ]; then
  tar -C "${OBJECT_STORAGE_DIRECTORY:-/data/object-storage}" -cf "$work/object-storage.tar" .
fi

(
  cd "$work"
  sha256sum database.dump >SHA256SUMS
  if [ -f object-storage.tar ]; then
    sha256sum object-storage.tar >>SHA256SUMS
  fi
)
restic backup "$work" --tag bob-runtime --tag "schema-${DATABASE_SCHEMA_VERSION:-unknown}"
restic forget --tag bob-runtime --keep-daily "${BACKUP_KEEP_DAILY:-14}" \
  --keep-weekly "${BACKUP_KEEP_WEEKLY:-8}" --keep-monthly "${BACKUP_KEEP_MONTHLY:-12}" --prune
restic check --read-data-subset="${BACKUP_CHECK_SUBSET:-5%}"
printf '%s\n' "$stamp" >"${BACKUP_STATUS_FILE:-/tmp/last-successful-backup}"
