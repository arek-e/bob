path "ops/metadata/apps/prod/bob/pi-auth/openai-codex" {
  capabilities = ["read", "list", "delete"]
}

path "ops/metadata/apps/prod/bob/owners/+/pi-auth/openai-codex" {
  capabilities = ["read", "list", "delete"]
}
