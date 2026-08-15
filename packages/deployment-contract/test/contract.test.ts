import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

import {
  DEPLOYMENT_SCHEMA_VERSION,
  deploymentContractDigest,
  validateDeploymentContract
} from "../src/index.js"

const contract = {
  schemaVersion: DEPLOYMENT_SCHEMA_VERSION,
  composeFile: "compose.yaml",
  composeDigest: `sha256:${"a".repeat(64)}`,
  services: [
    {
      name: "agent",
      imageName: "agent",
      imageEnvironmentVariable: "BOB_AGENT_IMAGE_DIGEST",
      requiredConfiguration: ["CORE_URL"],
      requiredSecrets: ["CORE_ACCESS_CLIENT_SECRET"]
    }
  ],
  readinessPath: "/readyz",
  backupCommand: ["docker", "compose", "run", "backup-runner"]
} as const

describe("Runtime deployment contract", () => {
  it("has a stable canonical digest", () => {
    const validated = validateDeploymentContract(contract)
    expect(deploymentContractDigest(validated)).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(deploymentContractDigest(validated)).toBe(
      deploymentContractDigest(validateDeploymentContract({ ...contract }))
    )
  })

  it("rejects paths outside the contract directory", () => {
    expect(() =>
      validateDeploymentContract({ ...contract, composeFile: "../compose.yaml" })
    ).toThrow("Compose path")
  })

  it("matches the published Compose file", async () => {
    const repository = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..")
    const published = validateDeploymentContract(
      JSON.parse(await readFile(resolve(repository, "deployment-contract.json"), "utf8"))
    )
    const compose = await readFile(resolve(repository, published.composeFile))
    expect(`sha256:${createHash("sha256").update(compose).digest("hex")}`).toBe(
      published.composeDigest
    )
    expect(published.services.map((service) => service.name)).toEqual([
      "agent-secret-init",
      "agent",
      "tunnel",
      "backup-runner",
      "observer"
    ])
    const composeText = compose.toString("utf8")
    for (const service of published.services) {
      expect(composeText).toContain(`  ${service.name}:`)
      expect(composeText).toContain(`\${${service.imageEnvironmentVariable}:?}`)
    }
  })
})
