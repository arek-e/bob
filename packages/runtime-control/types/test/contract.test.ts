import { Schema } from "effect"
import { readFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"

import { RuntimeCompatibilityContract, RuntimeReleaseContract } from "../src/contract.ts"

const digest = `sha256:${"a".repeat(64)}`

const contract = {
  schemaVersion: "bob.runtime-control.v1",
  releaseId: "runtime-20260817",
  sourceRevision: "a".repeat(40),
  deploymentProfileId: "core",
  capabilityCatalogueGeneration: "capability-v2:14603f15de62d729",
  executionPoolId: "core-20260817",
  roles: [
    {
      roleId: "agent-worker",
      imageName: "agent-worker",
      imageDigest: digest,
      mode: "scalable",
      defaultReplicas: 2,
      maximumReplicas: 32,
      executionSlotsPerReplica: 4,
      readinessPath: "/ready",
      dependencies: ["postgresql", "redis", "object-storage", "openbao"]
    }
  ],
  protocols: {
    agentRunJob: { minimum: 1, maximum: 1 },
    coreGateway: { minimum: 1, maximum: 1 },
    checkpointLoop: { minimum: 1, maximum: 1 }
  },
  database: {
    schemaVersion: 1,
    minimumCompatibleSchemaVersion: 1,
    minimumRollbackSchemaVersion: 1,
    migrationMode: "expand"
  },
  requiredSharedServices: ["postgresql", "redis", "object-storage"],
  composeDigest: digest,
  configurationDigest: digest,
  backup: {
    formatVersion: 1,
    maximumAgeSeconds: 18_000,
    restoreVerificationRequired: true
  },
  rollout: {
    drainTimeoutSeconds: 600,
    observationSeconds: 1_800,
    retainPreviousRelease: true
  }
} as const

describe("Runtime release contract", () => {
  it("decodes the published Runtime compatibility contract", async () => {
    const document = JSON.parse(
      await readFile(
        new URL("../../../../deployment/runtime-control.json", import.meta.url),
        "utf8"
      )
    )
    expect(Schema.decodeUnknownSync(RuntimeCompatibilityContract)(document)).toEqual(document)
  })

  it("accepts one complete compatible release description", () => {
    expect(Schema.decodeUnknownSync(RuntimeReleaseContract)(contract)).toEqual(contract)
  })

  it("rejects duplicate role identities", () => {
    expect(() =>
      Schema.decodeUnknownSync(RuntimeReleaseContract)({
        ...contract,
        roles: [...contract.roles, contract.roles[0]]
      })
    ).toThrow()
  })

  it("requires execution slots only on Agent Workers", () => {
    expect(() =>
      Schema.decodeUnknownSync(RuntimeReleaseContract)({
        ...contract,
        roles: [{ ...contract.roles[0], roleId: "core-api" }]
      })
    ).toThrow()
  })
})
