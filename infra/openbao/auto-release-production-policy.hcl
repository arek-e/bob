path "ops/data/apps/prod/bob/control-plane/coolify" {
  capabilities = ["read"]
}

path "ops/data/apps/prod/bob/access/core-to-agent-admin" {
  capabilities = ["read"]
}

path "auth/token/revoke-self" {
  capabilities = ["update"]
}
