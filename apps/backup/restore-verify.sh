#!/bin/sh
set -eu

: "${RESTIC_REPOSITORY:?RESTIC_REPOSITORY is required}"
: "${RESTIC_PASSWORD_FILE:?RESTIC_PASSWORD_FILE is required}"
: "${RESTORE_DATABASE_URL:?RESTORE_DATABASE_URL is required}"

work="$(mktemp -d)"
restic restore latest --tag bob-runtime --target "$work"
dump="$(find "$work" -type f -name database.dump -print -quit)"
test -n "$dump"
snapshot_dir="$(dirname "$dump")"
(cd "$snapshot_dir" && sha256sum -c SHA256SUMS)
pg_restore --dbname "$RESTORE_DATABASE_URL" --exit-on-error --no-owner "$dump"
psql "$RESTORE_DATABASE_URL" --no-psqlrc --tuples-only --command \
  "SELECT count(*) >= 0 FROM auth_user" | grep -q t
date -u +%Y%m%dT%H%M%SZ >"${RESTORE_STATUS_FILE:-/tmp/last-successful-restore}"
