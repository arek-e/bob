import { readFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"

async function repositoryFile(path: string): Promise<string> {
  return readFile(path, "utf8")
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
      repositoryFile("infra/cloudflare/.env.schema")
    ])

    for (const file of files) {
      expect(file).not.toContain("BOB_STAGE")
      expect(file).not.toContain("BOB_SECRET_STAGE")
      expect(file).not.toContain("PUBLIC_STAGE")
    }
  })

  it("keeps managed production infrastructure outside the Runtime repository", async () => {
    const [compose, controlPlaneSeam] = await Promise.all([
      repositoryFile("infra/coolify/compose.yaml"),
      repositoryFile("scripts/verify-boundaries.mjs")
    ])

    expect(compose).toContain("CLOUDFLARED_TUNNEL_TOKEN")
    expect(compose).toContain("BOB_AGENT_IMAGE_DIGEST")
    expect(controlPlaneSeam).not.toContain("infra/kubernetes")
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
      "CLOUDFLARE_WORKERS_SUBDOMAIN",
      "CLOUDFLARE_CORE_WORKER_NAME",
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

  it("publishes both production images with provenance from an explicit release commit", async () => {
    const workflow = await repositoryFile(".github/workflows/release-images.yml")

    expect(workflow).toContain("workflow_dispatch:")
    expect(workflow).toContain("packages: write")
    expect(workflow).toContain("id-token: write")
    expect(workflow).toContain("attestations: write")
    expect(workflow).toContain("platforms: linux/amd64,linux/arm64")
    expect(workflow).toContain("file: apps/agent/Dockerfile")
    expect(workflow).toContain("file: tools/data-backup/Dockerfile")
    expect(workflow.match(/provenance: mode=max/gu)).toHaveLength(2)
    expect(workflow.match(/sbom: true/gu)).toHaveLength(2)
    expect(workflow.match(/actions\/attest-build-provenance@v2/gu)).toHaveLength(2)
    expect(workflow).not.toContain("pull_request:")
  })
})
