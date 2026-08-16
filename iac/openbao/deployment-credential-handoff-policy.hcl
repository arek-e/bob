path "ops/data/apps/prod/bob/access/core-to-agent" {
  capabilities = ["create", "update"]
}

path "ops/data/apps/prod/bob/access/core-to-agent-admin" {
  capabilities = ["create", "update"]
}

path "ops/data/apps/prod/bob/access/agent-to-core" {
  capabilities = ["create", "update"]
}


path "auth/token/revoke-self" {
  capabilities = ["update"]
}
