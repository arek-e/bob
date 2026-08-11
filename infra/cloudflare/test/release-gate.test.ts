import { readFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"

describe("trusted infrastructure plan", () => {
  it("declares the reviewed credential handoff before Alchemy planning", async () => {
    const workflows = await Promise.all([
      readFile(new URL("../../../.github/workflows/release-gate.yml", import.meta.url), "utf8"),
      readFile(new URL("../../../.github/workflows/ci.yml", import.meta.url), "utf8")
    ])

    for (const workflow of workflows) {
      expect(workflow).toContain('RUNTIME_CREDENTIAL_HANDOFF_ENABLED: "true"')
      expect(workflow).toContain("id-token: write")
      expect(workflow).toContain("run: pnpm infra:plan")
      expect(workflow).toContain("BAO_JWT_ROLE")
      expect(workflow).not.toContain("BAO_DEPLOY_TOKEN")
      expect(workflow).not.toContain("BOB_STAGE")
      expect(workflow).not.toContain("staging")
    }
    expect(workflows[0]).toContain("environment: production")
  })

  it("exercises the production contract with offline Alchemy fixtures", async () => {
    const smoke = await readFile(new URL("../alchemy.smoke.run.ts", import.meta.url), "utf8")
    const packageManifest = await readFile(new URL("../package.json", import.meta.url), "utf8")

    expect(smoke).not.toContain("BOB_STAGE")
    expect(smoke).toContain("RUNTIME_CREDENTIAL_HANDOFF_ENABLED: true")
    expect(packageManifest).toContain("--stage prod")
  })

  it("installs exact pnpm before setup-node enables its cache", async () => {
    const workflows = await Promise.all([
      readFile(new URL("../../../.github/workflows/release-gate.yml", import.meta.url), "utf8"),
      readFile(new URL("../../../.github/workflows/ci.yml", import.meta.url), "utf8")
    ])

    for (const workflow of workflows) {
      const nodeSetups = workflow.match(/uses: actions\/setup-node@v4/gu) ?? []
      const pnpmBeforeNode =
        workflow.match(
          /uses: pnpm\/action-setup@v4\s+with:\s+version: 10\.19\.0\s+- uses: actions\/setup-node@v4/gu
        ) ?? []
      expect(pnpmBeforeNode).toHaveLength(nodeSetups.length)
      expect(workflow).not.toContain("corepack prepare pnpm")
    }
  })

  it("plans the exact reviewed release commit", async () => {
    const [releaseGate, ci] = await Promise.all([
      readFile(new URL("../../../.github/workflows/release-gate.yml", import.meta.url), "utf8"),
      readFile(new URL("../../../.github/workflows/ci.yml", import.meta.url), "utf8")
    ])

    expect(releaseGate).toContain("release_sha:")
    expect(releaseGate).toContain("BOB_RELEASE_SHA: ${{ inputs.release_sha }}")
    expect(releaseGate).toContain("ref: ${{ inputs.release_sha }}")
    expect(releaseGate).toContain("fetch-depth: 0")
    expect(releaseGate).toContain("RELEASE_SHA: ${{ inputs.release_sha }}")
    expect(releaseGate).toContain('[[ "$RELEASE_SHA" =~ ^[0-9a-f]{40}$ ]]')
    expect(releaseGate).toContain('test "$(git rev-parse HEAD)" = "$RELEASE_SHA"')
    expect(releaseGate).toContain('git merge-base --is-ancestor "$RELEASE_SHA" origin/main')
    expect(ci).toContain("BOB_RELEASE_SHA: ${{ github.sha }}")
  })

  it("documents the protected Worker OTLP release path", async () => {
    const [deployment, operations] = await Promise.all([
      readFile(new URL("../../../docs/runbooks/deployment.md", import.meta.url), "utf8"),
      readFile(new URL("../../../docs/runbooks/operations.md", import.meta.url), "utf8")
    ])

    expect(deployment).toContain(
      'gh workflow run release-gate.yml --ref main -f release_sha="$GITOPS_SHA"'
    )
    expect(deployment).toContain('OTLP_URL="https://bob-otel.${BOB_DOMAIN}"')
    expect(deployment).toContain('export BOB_RELEASE_SHA="$GITOPS_SHA"')
    expect(deployment).toContain("Do not copy the Worker OTLP token to OpenBao")
    expect(operations).toContain("`https://bob-otel.<BOB_DOMAIN>/v1/traces`")
    expect(operations).toContain("The Node agent does not use this Access token")
  })
})
