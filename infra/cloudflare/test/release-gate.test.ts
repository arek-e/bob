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
})
