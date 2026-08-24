import { readFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"

import { readMaintenanceExecutionContext } from "../maintenance/context.js"

describe("maintenance environment contract", () => {
  it("keeps OpenBao resolution scoped to the reviewed Runtime Cluster fields", async () => {
    const schema = await readFile(new URL("../.env.schema", import.meta.url), "utf8")

    expect(schema).toContain("@import(../.env.schema, pick=[BAO_ADDR, BAO_JWT_ROLE])")
    expect(schema).toContain("@plugin(@varlock/hashicorp-vault-plugin)")
    expect(schema).toContain('pathPrefix="ops/apps/prod/bob"')
    expect(schema.match(/vaultSecret\("runtime-cluster#[A-Z0-9_]+"\)/gu)).toEqual([
      'vaultSecret("runtime-cluster#DATABASE_URL")',
      'vaultSecret("runtime-cluster#DATA_KEK_ACTIVE_VERSION")',
      'vaultSecret("runtime-cluster#DATA_KEK_KEYRING_JSON")',
      'vaultSecret("runtime-cluster#DATA_LOOKUP_KEY")'
    ])
  })

  it("requires release identity for a cluster job", () => {
    expect(() =>
      readMaintenanceExecutionContext({
        BOB_MAINTENANCE_ENVIRONMENT: "production",
        BOB_MAINTENANCE_CLUSTER_ID: "prod-eu",
        BOB_MAINTENANCE_DEPLOYMENT_PROFILE_ID: "core",
        BOB_MAINTENANCE_MODE: "cluster-job"
      })
    ).toThrow("BOB_MAINTENANCE_RELEASE_ID and BOB_MAINTENANCE_EXECUTION_ID")
  })

  it("keeps the cluster target explicit instead of deriving it from the database URL", () => {
    expect(
      readMaintenanceExecutionContext({
        DATABASE_URL: "postgresql://postgresql:5432/bob",
        BOB_MAINTENANCE_ENVIRONMENT: "production",
        BOB_MAINTENANCE_CLUSTER_ID: "prod-eu",
        BOB_MAINTENANCE_DEPLOYMENT_PROFILE_ID: "core",
        BOB_MAINTENANCE_TARGET_REGION: "eu",
        BOB_MAINTENANCE_TARGET_PROVIDER: "aws",
        BOB_MAINTENANCE_RUNTIME_ADAPTER: "argo",
        BOB_MAINTENANCE_TARGET_REFERENCE: "eks/prod-eu",
        BOB_MAINTENANCE_TARGET_SOURCE: "terraform",
        BOB_MAINTENANCE_TARGET_SOURCE_REVISION: "terraform-prod-eu-1",
        BOB_MAINTENANCE_MODE: "cluster-job",
        BOB_MAINTENANCE_RELEASE_ID: "runtime-release",
        BOB_MAINTENANCE_EXECUTION_ID: "job-123",
        BOB_MAINTENANCE_IMAGE_SOURCE: "commit-build",
        BOB_MAINTENANCE_IMAGE_DIGEST: `sha256:${"a".repeat(64)}`,
        BOB_MAINTENANCE_SOURCE_REVISION: "b".repeat(40)
      })
    ).toMatchObject({
      clusterId: "prod-eu",
      mode: "cluster-job",
      image: {
        name: "core",
        source: "commit-build",
        sourceRevision: "b".repeat(40)
      }
    })
  })

  it("supports an agent context without local database access", () => {
    expect(
      readMaintenanceExecutionContext({
        BOB_MAINTENANCE_ENVIRONMENT: "production",
        BOB_MAINTENANCE_CLUSTER_ID: "prod-eu",
        BOB_MAINTENANCE_DEPLOYMENT_PROFILE_ID: "core",
        BOB_MAINTENANCE_TARGET_REGION: "eu",
        BOB_MAINTENANCE_TARGET_PROVIDER: "aws",
        BOB_MAINTENANCE_RUNTIME_ADAPTER: "argo",
        BOB_MAINTENANCE_TARGET_REFERENCE: "eks/prod-eu",
        BOB_MAINTENANCE_TARGET_SOURCE: "terraform",
        BOB_MAINTENANCE_MODE: "agent",
        BOB_MAINTENANCE_IMAGE_SOURCE: "pinned-image",
        BOB_MAINTENANCE_IMAGE_DIGEST: `sha256:${"a".repeat(64)}`
      })
    ).toMatchObject({ mode: "agent", clusterId: "prod-eu" })
  })
})
