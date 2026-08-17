import { Schema } from "effect"
import { describe, expect, it } from "vitest"

import { RuntimeReleaseContract } from "../src/contract.ts"

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
  requiredSharedServices: ["postgresql", "redis", "object-storage"]
} as const

describe("Runtime release contract", () => {
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
