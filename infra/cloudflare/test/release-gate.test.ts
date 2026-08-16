import { readFile, readdir } from "node:fs/promises"
import { describe, expect, it } from "vitest"

const workflowRoot = new URL("../../../.github/workflows/", import.meta.url)
const workflow = (name: string) => readFile(new URL(name, workflowRoot), "utf8")

describe("Runtime release boundary", () => {
  it("limits the production identity to the protected release workflow", async () => {
    const names = (await readdir(workflowRoot)).filter((name) => name.endsWith(".yml"))
    const workflows = await Promise.all(
      names.filter((name) => name !== "auto-release.yml").map((name) => workflow(name))
    )

    for (const source of workflows) {
      expect(source).not.toContain("environment: production")
      expect(source).not.toContain("environment: production-readonly")
      expect(source).not.toContain("BAO_JWT_ROLE")
      expect(source).not.toContain("CONTROL_PLANE_URL")
      expect(source).not.toContain("id-token: write")
      expect(source).not.toContain("tailscale/github-action")
      expect(source).not.toContain("/v1/instances/${BOB_INSTANCE_ID}/releases")
    }
    const release = await workflow("auto-release.yml")
    expect(release).toContain("environment: production")
    expect(release).toContain("BAO_JWT_ROLE_AUTO_RELEASE")
    expect(release).toContain("tailscale/github-action")
    expect(release).toContain("COOLIFY_HOST_ADDRESS")
    expect(release).toContain("sudo tee -a /etc/hosts")
    expect(release).toContain("COOLIFY_RUNTIME_APPLICATION_UUID")
    expect(release).toContain("AGENT_ADMIN_ORIGIN_URL")
    expect(release).not.toContain("AGENT_ORIGIN_URL")
    expect(release).not.toContain("apps/prod/bob/config")
    expect(release).not.toContain("CONTROL_PLANE_URL")
  })

  it("prepares immutable artifacts after successful main CI", async () => {
    const [preparation, images] = await Promise.all([
      workflow("auto-release.yml"),
      workflow("release-images.yml")
    ])

    expect(preparation).toContain("name: Release Runtime")
    expect(preparation).toContain("workflow_run:")
    expect(preparation).toContain("workflows: [CI]")
    expect(preparation).toContain("github.event.workflow_run.conclusion == 'success'")
    expect(preparation).toContain("github.event.workflow_run.event == 'push'")
    expect(preparation).toContain("github.event.workflow_run.head_branch == 'main'")
    expect(preparation).toContain("vars.BOB_AUTO_RELEASE_ENABLED == 'true'")
    expect(preparation).toContain("git ls-remote origin refs/heads/main")
    expect(preparation).toContain("uses: ./.github/workflows/release-images.yml")
    expect(preparation).toContain("BUNDLE_REFERENCE")
    expect(preparation).not.toContain("git push origin HEAD:main")
    expect(preparation).not.toContain("contents: write")
    expect(preparation).toContain("ready for Coolify")
    expect(preparation).not.toContain("gh workflow run")
    expect(preparation).not.toContain("gh run watch")
    expect(images).toContain("workflow_call:")
    expect(images).toContain("agent_digest:")
    expect(images).toContain("backup_digest:")
    expect(images).toContain("bundle_digest:")
    expect(images).toContain("bundle_reference:")
    expect(images).toContain("oras push")
    expect(images).toContain("scripts/release-bundle.mjs create")
  })

  it("publishes both images from the exact source SHA", async () => {
    const images = await workflow("release-images.yml")

    expect(images).toContain("release_sha:")
    expect(images).toContain("ref: ${{ inputs.release_sha }}")
    expect(images.match(/sha-\$\{\{ inputs\.release_sha \}\}/gu)).toHaveLength(2)
    expect(images.match(/provenance: mode=max/gu)).toHaveLength(2)
    expect(images.match(/sbom: true/gu)).toHaveLength(2)
  })

  it("documents Coolify as the current production promotion target", async () => {
    const deployment = await readFile(
      new URL("../../../docs/runbooks/deployment.md", import.meta.url),
      "utf8"
    )

    expect(deployment).toContain("protected `Release Runtime` workflow")
    expect(deployment).toContain("Coolify records the deployment")
    expect(deployment).toContain("restores the prior image pins")
    expect(deployment).toContain("`teampitch-ops` OpenTofu owns")
    expect(deployment).toContain("Do not apply Runtime Alchemy in production")
  })
})
