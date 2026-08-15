import { readFile, readdir } from "node:fs/promises"
import { describe, expect, it } from "vitest"

const workflowRoot = new URL("../../../.github/workflows/", import.meta.url)
const workflow = (name: string) => readFile(new URL(name, workflowRoot), "utf8")

describe("public Runtime release boundary", () => {
  it("keeps production identities and environments out of public workflows", async () => {
    const names = (await readdir(workflowRoot)).filter((name) => name.endsWith(".yml"))
    const workflows = await Promise.all(names.map((name) => workflow(name)))

    for (const source of workflows) {
      expect(source).not.toContain("environment: production")
      expect(source).not.toContain("environment: production-readonly")
      expect(source).not.toContain("BAO_JWT_ROLE")
      expect(source).not.toContain("CONTROL_PLANE_URL")
      expect(source).not.toContain("id-token: write")
      expect(source).not.toContain("tailscale/github-action")
      expect(source).not.toContain("/v1/instances/${BOB_INSTANCE_ID}/releases")
    }
  })

  it("prepares immutable artifacts after successful main CI", async () => {
    const [preparation, images] = await Promise.all([
      workflow("auto-release.yml"),
      workflow("release-images.yml")
    ])

    expect(preparation).toContain("name: Prepare Runtime release")
    expect(preparation).toContain("workflow_run:")
    expect(preparation).toContain("workflows: [CI]")
    expect(preparation).toContain("github.event.workflow_run.conclusion == 'success'")
    expect(preparation).toContain("github.event.workflow_run.event == 'push'")
    expect(preparation).toContain("github.event.workflow_run.head_branch == 'main'")
    expect(preparation).toContain("vars.BOB_RELEASE_PREPARATION_ENABLED == 'true'")
    expect(preparation).toContain("git ls-remote origin refs/heads/main")
    expect(preparation).toContain("uses: ./.github/workflows/release-images.yml")
    expect(preparation).toContain("BUNDLE_REFERENCE")
    expect(preparation).not.toContain("git push origin HEAD:main")
    expect(preparation).not.toContain("contents: write")
    expect(preparation).toContain("ready for the private Control Plane")
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

  it("documents the private Control Plane as the production release owner", async () => {
    const deployment = await readFile(
      new URL("../../../docs/runbooks/deployment.md", import.meta.url),
      "utf8"
    )

    expect(deployment).toContain("gh workflow run release.yml -R arek-e/bob-control-plane")
    expect(deployment).toContain('-f bundle_reference="$BUNDLE_REFERENCE"')
    expect(deployment).toContain(
      "Production validation and deployment run only in the private Control Plane"
    )
    expect(deployment).toContain("`teampitch-ops` OpenTofu owns")
    expect(deployment).toContain("Do not apply Runtime Alchemy in production")
  })
})
