import { access, readFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"

const repositoryRoot = new URL("../../../", import.meta.url)
const repositoryFile = (path: string) => readFile(new URL(path, repositoryRoot), "utf8")

describe("production-only deployment contract", () => {
  it("has no stage selector", async () => {
    const files = await Promise.all([
      repositoryFile(".env.schema"),
      repositoryFile("apps/core-worker/.env.schema"),
      repositoryFile("apps/sendblue-channel/ingress/.env.schema"),
      repositoryFile("apps/sendblue-channel/egress/.env.schema"),
      repositoryFile("apps/agent/.env.schema"),
      repositoryFile("infra/cloudflare/.env.schema")
    ])
    for (const file of files) {
      expect(file).not.toContain("BOB_STAGE")
      expect(file).not.toContain("BOB_SECRET_STAGE")
    }
  })

  it("keeps only the Coolify private runtime contract", async () => {
    await expect(
      access(new URL("infra/coolify/compose.yaml", repositoryRoot))
    ).resolves.toBeUndefined()
    await expect(
      access(new URL("infra/kubernetes/kustomization.yaml", repositoryRoot))
    ).rejects.toThrow()
    await expect(access(new URL("infra/argocd/application.yaml", repositoryRoot))).rejects.toThrow()
  })

  it("uses exact production OpenBao paths", async () => {
    const policies = await Promise.all([
      repositoryFile("infra/openbao/agent-production-policy.hcl"),
      repositoryFile("infra/openbao/agent-credential-admin-policy.hcl"),
      repositoryFile("infra/openbao/deployment-credential-handoff-policy.hcl")
    ])
    for (const policy of policies) {
      expect(policy).toMatch(/path "ops\/(?:data|metadata)\/apps\/prod\/bob\//u)
      expect(policy).not.toContain("ops/apps/staging")
    }
  })

  it("defines the R2 backup retention lock", async () => {
    const lock = JSON.parse(await repositoryFile("infra/cloudflare/r2-backup-lock.json"))
    expect(lock.rules[0]).toMatchObject({
      id: "retain-all-backups-90-days",
      enabled: true,
      condition: { type: "Age", maxAgeSeconds: 7_776_000 }
    })
  })
})
