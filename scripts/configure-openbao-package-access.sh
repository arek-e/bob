#!/usr/bin/env bash
set -euo pipefail

readonly BAO_ADDRESS="${BAO_ADDR:-https://vault.lamb-bicolor.ts.net}"
readonly POLICY_NAME="bob-runtime-ci-packages"
readonly ROLE_NAME="bob-runtime-ci-packages"
readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly REPOSITORY_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
readonly POLICY_FILE="$REPOSITORY_ROOT/infra/openbao/bob-runtime-ci-packages-policy.hcl"
readonly ROLE_FILE="$REPOSITORY_ROOT/infra/openbao/bob-runtime-ci-packages-jwt-role.json"

if [[ -z "${BAO_TOKEN:-}" ]]; then
  printf '%s\n' 'BAO_TOKEN is required. Authenticate with OpenBao before running this command.' >&2
  exit 1
fi

umask 077
jwt_config_file="$(mktemp /tmp/bob-runtime-jwt-config.XXXXXX)"
trap 'unlink "$jwt_config_file" 2>/dev/null || true' EXIT

bao read -address="$BAO_ADDRESS" -format=json auth/jwt/config >"$jwt_config_file"

if ! jq -e '
  .data.oidc_discovery_url == "https://token.actions.githubusercontent.com" and
  .data.bound_issuer == "https://token.actions.githubusercontent.com"
' "$jwt_config_file" >/dev/null; then
  printf '%s\n' 'OpenBao JWT auth is not configured for the GitHub Actions issuer.' >&2
  exit 1
fi

bao policy write -address="$BAO_ADDRESS" "$POLICY_NAME" "$POLICY_FILE" >/dev/null
bao write -address="$BAO_ADDRESS" "auth/jwt/role/$ROLE_NAME" "@$ROLE_FILE" >/dev/null

printf 'configured OpenBao JWT role %s with policy %s\n' "$ROLE_NAME" "$POLICY_NAME"
