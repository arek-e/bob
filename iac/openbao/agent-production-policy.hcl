path "ops/data/apps/prod/bob/pi-auth/openai-codex" {
  capabilities = ["create", "read", "update"]
}

path "ops/metadata/apps/prod/bob/pi-auth/openai-codex" {
  capabilities = ["read", "list"]
}

path "ops/data/apps/prod/bob/owners/+/pi-auth/openai-codex" {
  capabilities = ["create", "read", "update"]
}

path "ops/metadata/apps/prod/bob/owners/+/pi-auth/openai-codex" {
  capabilities = ["read", "list"]
}
