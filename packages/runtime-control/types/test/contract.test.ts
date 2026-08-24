import { Schema } from "effect"
import { readFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"

import {
  MaintenanceJobSpec,
  RuntimeCompatibilityContract,
  RuntimeReleaseContract
} from "../src/contract.ts"

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

  it("accepts a cluster-scoped maintenance job with a pinned release image", () => {
    const job = {
      schemaVersion: "bob.maintenance-job.v1",
      executionId: "maintenance-job-1",
      target: {
        environment: "production",
        clusterId: "prod-eu",
        deploymentProfileId: "core",
        releaseId: "runtime-release"
      },
      image: {
        name: "core",
        source: "runtime-release",
        digest
      },
      command: { name: "migrate", arguments: [] }
    }

    expect(Schema.decodeUnknownSync(MaintenanceJobSpec)(job)).toEqual(job)
  })

  it("accepts a Control Plane UUID release identity", () => {
    expect(
      Schema.decodeUnknownSync(MaintenanceJobSpec)({
        schemaVersion: "bob.maintenance-job.v1",
        executionId: "maintenance-job-1",
        target: {
          environment: "production",
          clusterId: "prod-eu",
          deploymentProfileId: "core",
          releaseId: "12345678-1234-1234-1234-123456789abc"
        },
        image: { name: "core", source: "pinned-image", digest },
        command: { name: "migrate", arguments: [] }
      })
    ).toMatchObject({ target: { releaseId: "12345678-1234-1234-1234-123456789abc" } })
  })

  it("requires a source revision for a commit-built Core image", () => {
    expect(() =>
      Schema.decodeUnknownSync(MaintenanceJobSpec)({
        schemaVersion: "bob.maintenance-job.v1",
        executionId: "maintenance-job-1",
        target: {
          environment: "production",
          clusterId: "prod-eu",
          deploymentProfileId: "core",
          releaseId: "runtime-release"
        },
        image: {
          name: "core",
          source: "commit-build",
          digest
        },
        command: { name: "migrate", arguments: [] }
      })
    ).toThrow()
  })

  it("rejects mutable Core image tags", () => {
    expect(() =>
      Schema.decodeUnknownSync(MaintenanceJobSpec)({
        schemaVersion: "bob.maintenance-job.v1",
        executionId: "maintenance-job-1",
        target: {
          environment: "production",
          clusterId: "prod-eu",
          deploymentProfileId: "core",
          releaseId: "runtime-release"
        },
        image: {
          name: "core",
          source: "pinned-image",
          digest: "latest"
        },
        command: { name: "migrate", arguments: [] }
      })
    ).toThrow()
  })

  it("rejects full image references in the maintenance contract", () => {
    expect(() =>
      Schema.decodeUnknownSync(MaintenanceJobSpec)({
        schemaVersion: "bob.maintenance-job.v1",
        executionId: "maintenance-job-1",
        target: {
          environment: "production",
          clusterId: "prod-eu",
          deploymentProfileId: "core",
          releaseId: "runtime-release"
        },
        image: {
          name: "core",
          source: "pinned-image",
          digest: `ghcr.io/arek-e/bob-core@${digest}`
        },
        command: { name: "migrate", arguments: [] }
      })
    ).toThrow()
  })

  it("requires the Core project image", () => {
    expect(() =>
      Schema.decodeUnknownSync(MaintenanceJobSpec)({
        schemaVersion: "bob.maintenance-job.v1",
        executionId: "maintenance-job-1",
        target: {
          environment: "production",
          clusterId: "prod-eu",
          deploymentProfileId: "core",
          releaseId: "runtime-release"
        },
        image: {
          name: "migration",
          source: "pinned-image",
          digest
        },
        command: { name: "migrate", arguments: [] }
      })
    ).toThrow()
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
