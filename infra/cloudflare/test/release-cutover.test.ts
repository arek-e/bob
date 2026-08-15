import { readFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"

const repositoryRoot = new URL("../../../", import.meta.url)
const repositoryFile = (path: string) => readFile(new URL(path, repositoryRoot), "utf8")

describe("production release cutover contract", () => {
  it("publishes both images from the exact source SHA", async () => {
    const workflow = await repositoryFile(".github/workflows/release-images.yml")
    expect(workflow).toContain("release_sha:")
    expect(workflow).toContain("ref: ${{ inputs.release_sha }}")
    expect(workflow.match(/sha-\$\{\{ inputs\.release_sha \}\}/gu)).toHaveLength(2)
    expect(workflow.match(/provenance: mode=max/gu)).toHaveLength(2)
    expect(workflow.match(/sbom: true/gu)).toHaveLength(2)
  })

  it("uses an immutable release bundle as the private release seam", async () => {
    const [workflow, runbook] = await Promise.all([
      repositoryFile(".github/workflows/auto-release.yml"),
      repositoryFile("docs/runbooks/deployment.md")
    ])
    expect(workflow).toContain("BUNDLE_REFERENCE")
    expect(workflow).not.toContain("git push origin HEAD:main")
    expect(workflow).not.toContain("infra/kubernetes")
    expect(workflow).not.toContain("environment: production")
    expect(runbook).toContain("/v1/admin/readiness")
    expect(runbook).toContain("The Control Plane promotes the exact bundle digest")
  })

  it("defines a Control Plane rollback without an automatic uncertain resend", async () => {
    const recovery = await repositoryFile("docs/runbooks/incident-recovery.md")
    expect(recovery).toContain("Request rollback through the Bob Control Plane")
    expect(recovery).toContain("Never resend a claimed or uncertain outbox automatically")
    expect(recovery).not.toContain("kubectl")
  })
})
