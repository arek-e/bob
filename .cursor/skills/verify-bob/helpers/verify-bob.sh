#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../.." && pwd)"
artifact_dir="$repo_root/.cursor/skills/verify-bob/artifacts"

doctor() {
  command -v node >/dev/null
  command -v pnpm >/dev/null

  local help_output
  help_output="$(cd -- "$repo_root" && pnpm maint help 2>&1)"
  grep -Fq "Usage: pnpm maint" <<<"$help_output"
  grep -Fq "read-latest-messages" <<<"$help_output"

  local context_output
  context_output="$(cd -- "$repo_root" && pnpm maint context 2>&1)"
  grep -Fq '"clusterId": "local"' <<<"$context_output"
  grep -Fq '"mode": "local"' <<<"$context_output"

  printf 'doctor: maintenance CLI is ready\n'
}

prove() {
  mkdir -p "$artifact_dir"
  local artifact="$artifact_dir/maintenance-context.txt"
  local exit_code=0

  {
    printf 'feature=runtime-context\n'
    printf '$ pnpm --silent maint context\n'
    set +e
    (cd -- "$repo_root" && pnpm --silent maint context)
    exit_code=$?
    set -e
    printf 'exit_code=%s\n' "$exit_code"
  } >"$artifact" 2>&1

  test "$exit_code" -eq 0
  grep -Fq '"schemaVersion": "bob.maintenance-context.v1"' "$artifact"
  grep -Fq '"environment": "development"' "$artifact"
  grep -Fq '"clusterId": "local"' "$artifact"
  grep -Fq '"mode": "local"' "$artifact"
  printf 'prove: runtime-context passed; evidence=%s\n' "${artifact#$repo_root/}"
}

cleanup() {
  test -f "$artifact_dir/maintenance-context.txt"
  printf 'cleanup: no persistent CLI process was started\n'
  printf 'cleanup: evidence preserved at %s\n' ".cursor/skills/verify-bob/artifacts/maintenance-context.txt"
}

case "${1:-}" in
  doctor)
    doctor
    ;;
  prove)
    prove
    ;;
  cleanup)
    cleanup
    ;;
  *)
    printf 'Usage: %s {doctor|prove|cleanup}\n' "$0" >&2
    exit 2
    ;;
esac
