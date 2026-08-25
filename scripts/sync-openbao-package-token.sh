#!/usr/bin/env bash
set -euo pipefail

readonly BAO_ADDRESS="${BAO_ADDR:-https://vault.lamb-bicolor.ts.net}"
readonly BAO_MOUNT="ops"
readonly BAO_PATH="apps/prod/bob/registry/ghcr"
readonly GITHUB_REPOSITORY="arek-e/bob"

if [[ -z "${BAO_TOKEN:-}" ]]; then
  printf '%s\n' 'BAO_TOKEN is required. Authenticate with OpenBao before running this command.' >&2
  exit 1
fi

umask 077
token_file="$(mktemp /tmp/bob-runtime-package-token.XXXXXX)"
trap 'unlink "$token_file" 2>/dev/null || true' EXIT

bao kv get \
  -address="$BAO_ADDRESS" \
  -mount="$BAO_MOUNT" \
  -field=TEAMPITCH_PACKAGES_TOKEN \
  "$BAO_PATH" >"$token_file"

if [[ ! -s "$token_file" ]]; then
  printf '%s\n' 'OpenBao returned an empty TEAMPITCH_PACKAGES_TOKEN field.' >&2
  exit 1
fi

gh secret set \
  --repo "$GITHUB_REPOSITORY" \
  --app actions \
  TEAMPITCH_PACKAGES_TOKEN \
  <"$token_file" >/dev/null

printf 'synced TEAMPITCH_PACKAGES_TOKEN from %s/%s to %s\n' \
  "$BAO_MOUNT" "$BAO_PATH" "$GITHUB_REPOSITORY"
