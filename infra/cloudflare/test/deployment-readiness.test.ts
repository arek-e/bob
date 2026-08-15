import { execFileSync } from "node:child_process"
import { readFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"

import { assertDeploymentReadiness } from "../../../scripts/deployment-readiness.mjs"

const repositoryRoot = new URL("../../../", import.meta.url)

async function contract() {
  const [baseImages, runtimeContract, coolifyCompose, agentPolicy] = await Promise.all([
    readFile(new URL("infra/coolify/base-images.json", repositoryRoot), "utf8"),
    readFile(new URL("infra/coolify/runtime-contract.json", repositoryRoot), "utf8"),
    readFile(new URL("infra/coolify/compose.yaml", repositoryRoot), "utf8"),
    readFile(new URL("infra/openbao/agent-production-policy.hcl", repositoryRoot), "utf8")
  ])
  return { baseImages, runtimeContract, coolifyCompose, agentPolicy }
}

describe("Coolify production deployment readiness", () => {
  it("accepts the current release and runtime assurance contract", async () => {
    const input = await contract()
    expect(() => assertDeploymentReadiness(input)).not.toThrow()
  })

  it("rejects environment delivery of the AppRole secret ID", async () => {
    const input = await contract()
    expect(() =>
      assertDeploymentReadiness({
        ...input,
        coolifyCompose: input.coolifyCompose
          .replace(
            "BAO_APPROLE_SECRET_ID_PATH: /run/secrets/openbao_approle_secret_id",
            "BAO_APPROLE_SECRET_ID: ${BAO_APPROLE_SECRET_ID:?}"
          )
          .replace("target: openbao_approle_secret_id", "target: removed")
      })
    ).toThrow(/BAO_APPROLE_SECRET_ID_PATH|secret file/u)
  })

  it("rejects a backup schedule that exceeds the four-hour RPO", async () => {
    const input = await contract()
    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    const runtime = JSON.parse(input.runtimeContract) as { backup: { schedule: string } }
    runtime.backup.schedule = "15 */8 * * *"
    expect(() =>
      assertDeploymentReadiness({ ...input, runtimeContract: JSON.stringify(runtime) })
    ).toThrow(/four-hour RPO/u)
  })

  it("runs the repository verifier without Kubernetes tools", () => {
    const result = execFileSync("node", ["scripts/verify-deployment-readiness.mjs"], {
      cwd: repositoryRoot,
      encoding: "utf8"
    })
    expect(result).toContain("Coolify production contract")
  })
})
