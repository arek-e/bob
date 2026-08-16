#!/bin/sh
set -eu

export BAO_ADDR="${BAO_ADDR:-http://openbao:8200}"
export BAO_TOKEN="${OPENBAO_DEV_ROOT_TOKEN}"

until bao status >/dev/null 2>&1; do
  sleep 1
done

bao secrets enable -path=ops kv-v2 >/dev/null 2>&1 || true
bao auth enable approle >/dev/null 2>&1 || true
bao policy write bob-agent /config/agent-production-policy.hcl >/dev/null
bao write auth/approle/role/bob-agent \
  token_policies=bob-agent \
  token_ttl=1h \
  token_max_ttl=4h \
  secret_id_ttl=0 >/dev/null
bao write auth/approle/role/bob-agent/role-id role_id=bob-agent >/dev/null

secret_id="$(bao write -f -field=secret_id auth/approle/role/bob-agent/secret-id)"
umask 077
printf '%s' "${secret_id}" > /run/bob-secrets/openbao_approle_secret_id
chmod 0444 /run/bob-secrets/openbao_approle_secret_id

if [ -s /run/codex/credential.json ]; then
  bao kv put -mount=ops apps/prod/bob/pi-auth/openai-codex \
    @/run/codex/credential.json >/dev/null
fi
