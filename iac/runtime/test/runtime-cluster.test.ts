import { readFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"

describe("production Runtime Compose contract", () => {
  it("mounts the Agent Worker OpenBao identity at its configured container path", async () => {
    const compose = await readFile(
      new URL("../../../deployment/runtime-cluster.compose.yaml", import.meta.url),
      "utf8"
    )
    const worker = compose.slice(compose.indexOf("  agent-worker:"), compose.indexOf("  channel:"))

    expect(worker).toContain(
      "BAO_APPROLE_SECRET_ID_PATH: /run/secrets/openbao_agent_approle_secret_id"
    )
    expect(worker).toContain("secrets: [openbao_agent_approle_secret_id]")
    expect(compose).toContain("file: ${BAO_APPROLE_SECRET_ID_PATH:?}")
  })
})
