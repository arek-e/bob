import { readFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"

describe("public Runtime release contract", () => {
  it("publishes and attests the exact release SHA", async () => {
    const workflow = await readFile(".github/workflows/release-images.yml", "utf8")

    expect(workflow).toContain("release_sha:")
    expect(workflow).toContain("ref: ${{ inputs.release_sha }}")
    expect(workflow).toContain('[[ "$RELEASE_SHA" =~ ^[0-9a-f]{40}$ ]]')
    expect(workflow).toContain('test "$(git rev-parse HEAD)" = "$RELEASE_SHA"')
    expect(workflow.match(/actions\/attest-build-provenance@v2/gu)).toHaveLength(2)
    expect(workflow).toContain("AGENT_DIGEST: ${{ steps.agent.outputs.digest }}")
    expect(workflow).toContain("BACKUP_DIGEST: ${{ steps.backup.outputs.digest }}")
  })

  it("uses the Coolify contract instead of Kubernetes", async () => {
    const [runbook, workflow] = await Promise.all([
      readFile("docs/runbooks/deployment.md", "utf8"),
      readFile("scripts/verify-deployment-readiness.mjs", "utf8")
    ])

    expect(runbook).toContain("infra/coolify/compose.yaml")
    expect(runbook).toContain("Coolify")
    expect(workflow).toContain("validate-coolify-compose.mjs")
    expect(runbook).not.toContain("kubectl")
    expect(runbook).not.toContain("Argo")
  })
})
