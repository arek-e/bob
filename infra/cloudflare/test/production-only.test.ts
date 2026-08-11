import { access, readFile } from "node:fs/promises"

import { describe, expect, it } from "vitest"

const repositoryRoot = new URL("../../../", import.meta.url)

async function repositoryFile(path: string): Promise<string> {
  return readFile(new URL(path, repositoryRoot), "utf8")
}

describe("production-only deployment contract", () => {
  it("has no deployable stage selector or secret-stage remapping", async () => {
    const files = await Promise.all([
      repositoryFile(".env.schema"),
      repositoryFile("apps/core-worker/.env.schema"),
      repositoryFile("apps/sendblue-ingress/.env.schema"),
      repositoryFile("apps/sendblue-egress/.env.schema"),
      repositoryFile("apps/agent/.env.schema"),
      repositoryFile("apps/ui/.env.schema"),
      repositoryFile("tools/sendblue-reconcile/.env.schema"),
      repositoryFile("tools/pi-smoke/.env.schema"),
      repositoryFile("infra/cloudflare/.env.schema"),
      repositoryFile("infra/kubernetes/base/agent-config.yaml")
    ])

    for (const file of files) {
      expect(file).not.toContain("BOB_STAGE")
      expect(file).not.toContain("BOB_SECRET_STAGE")
      expect(file).not.toContain("PUBLIC_STAGE")
    }
  })

  it("uses only exact production OpenBao paths", async () => {
    const files = await Promise.all([
      repositoryFile("infra/kubernetes/base/secret-delivery.yaml"),
      repositoryFile("infra/openbao/agent-production-policy.hcl"),
      repositoryFile("infra/openbao/agent-secret-delivery-production-policy.hcl"),
      repositoryFile("infra/openbao/agent-credential-admin-policy.hcl"),
      repositoryFile("infra/openbao/argocd-repository-production-policy.hcl"),
      repositoryFile("infra/openbao/deployment-credential-handoff-policy.hcl")
    ])

    const [delivery, ...policies] = files
    expect(delivery).toContain("path: ops")
    expect(delivery).toContain('key: "apps/prod/bob/')
    expect(delivery).not.toContain("path: secret")
    for (const file of policies) {
      expect(file).toMatch(/path "ops\/(?:data|metadata)\/apps\/prod\/bob\//u)
      expect(file).not.toContain("secret/data/ops")
      expect(file).not.toContain("secret/metadata/ops")
    }
    for (const file of files) {
      expect(file).not.toContain("ops/apps/staging")
      expect(file).not.toContain("ops/apps/+/bob")
    }
    expect(files.at(-1)).toContain('path "auth/token/revoke-self"')
  })

  it("uses one production-only identity for Argo repository delivery", async () => {
    const [externalSecret, secretStore, serviceAccount, policy] = await Promise.all([
      repositoryFile("infra/argocd/repository-external-secret.yaml"),
      repositoryFile("infra/argocd/repository-secret-store.yaml"),
      repositoryFile("infra/argocd/repository-service-account.yaml"),
      repositoryFile("infra/openbao/argocd-repository-production-policy.hcl")
    ])

    expect(externalSecret).toContain("kind: SecretStore")
    expect(externalSecret).not.toContain("ClusterSecretStore")
    expect(externalSecret).toContain("key: apps/prod/bob/argocd/repository")
    expect(secretStore).toContain("role: bob-argocd-repository")
    expect(secretStore).toContain("name: bob-argocd-repository")
    expect(serviceAccount).toContain("automountServiceAccountToken: false")
    expect(policy).toContain('path "ops/data/apps/prod/bob/argocd/repository"')
    expect(policy.match(/^path /gmu)).toHaveLength(1)
    expect(policy).not.toContain("*")
    expect(policy).not.toContain("+")
  })

  it("has one production overlay and no stage variants", async () => {
    const [root, production] = await Promise.all([
      repositoryFile("infra/kubernetes/kustomization.yaml"),
      repositoryFile("infra/kubernetes/overlays/prod/kustomization.yaml")
    ])

    expect(root).toContain("- overlays/prod")
    expect(production).toContain("- ../../base")
    expect(production).not.toContain("staging")
    await expect(
      access(new URL("infra/kubernetes/overlays/staging/kustomization.yaml", repositoryRoot))
    ).rejects.toThrow()
    await expect(
      access(new URL("infra/kubernetes/overlays/production/kustomization.yaml", repositoryRoot))
    ).rejects.toThrow()
  })

  it("validates schemas with local fixtures and no production secret lookup", async () => {
    const validation = await repositoryFile("scripts/validate-env-schemas.mjs")

    expect(validation).toContain('BAO_ADDR: "https://openbao.fixture.invalid"')
    expect(validation).toContain('DATA_KEK_KEYRING_JSON: \'{"fixture-v1":"fixture-key"}\'')
    expect(validation).not.toContain("BOB_STAGE")
  })

  it("loads persistent production configuration from one OpenBao record", async () => {
    const schema = await repositoryFile("infra/cloudflare/.env.schema")
    const fields = [
      "BOB_DOMAIN",
      "OWNER_ACCESS_EMAIL",
      "ACCESS_TEAM_DOMAIN",
      "OWNER_ID",
      "OWNER_TIME_ZONE",
      "REMINDER_QUIET_HOURS_START",
      "REMINDER_QUIET_HOURS_END",
      "REMINDER_DAILY_LIMIT",
      "BOB_MODEL",
      "BOB_PROVIDER",
      "SENDBLUE_ENABLED",
      "ALCHEMY_PRODUCTION_STATE_APPROVED",
      "ALCHEMY_TELEMETRY_DISABLED",
      "RUNTIME_CREDENTIAL_HANDOFF_ENABLED",
      "ACCESS_SERVICE_TOKEN_ROTATION_VERSION",
      "ACCESS_SERVICE_TOKEN_ROTATE_BY",
      "AGENT_ORIGIN_URL"
    ]

    for (const field of fields) {
      expect(schema).toMatch(new RegExp(`^${field}=vaultSecret\\("config"\\)$`, "mu"))
    }
    expect(schema).toMatch(/^BAO_DEPLOY_TOKEN=$/mu)
  })
})
