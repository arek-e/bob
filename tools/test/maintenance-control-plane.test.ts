import { describe, expect, it } from "vitest"

import {
  createMaintenanceControlPlaneClient,
  type MaintenanceOperation
} from "../maintenance/control-plane.js"

const environment = {
  BOB_MAINTENANCE_ENVIRONMENT: "production",
  BOB_MAINTENANCE_CONTROL_PLANE_URL: "https://control-plane.example",
  BOB_MAINTENANCE_CONTROL_PLANE_TOKEN: "t".repeat(32)
} satisfies NodeJS.ProcessEnv

const job = {
  schemaVersion: "bob.maintenance-job.v1" as const,
  executionId: "maintenance-1",
  target: {
    environment: "production" as const,
    clusterId: "prod-eu",
    deploymentProfileId: "core",
    releaseId: "release-1"
  },
  image: {
    name: "core" as const,
    source: "pinned-image" as const,
    digest: `sha256:${"a".repeat(64)}`
  },
  command: { name: "read-latest-messages", arguments: ["--limit", "10"] }
}

describe("maintenance Control Plane client", () => {
  it("resolves environment, profile, and release from a cluster context", async () => {
    const client = createMaintenanceControlPlaneClient({
      env: environment,
      fetchImplementation: async () =>
        new Response(
          JSON.stringify({
            desiredReleaseId: "release-1",
            runtimeTarget: {
              id: "prod-eu",
              environment: "production",
              region: "eu",
              provider: "aws",
              runtimeAdapter: "argo",
              targetReference: "eks/prod-eu",
              deploymentProfileId: "core",
              accessPolicyId: "prod-maintenance",
              source: "terraform",
              sourceRevision: "terraform-prod-eu-1"
            }
          }),
          { status: 200 }
        )
    })

    await expect(client.getRuntimeTarget("prod-eu")).resolves.toEqual({
      desiredReleaseId: "release-1",
      target: {
        id: "prod-eu",
        environment: "production",
        region: "eu",
        provider: "aws",
        runtimeAdapter: "argo",
        targetReference: "eks/prod-eu",
        deploymentProfileId: "core",
        accessPolicyId: "prod-maintenance",
        source: "terraform",
        sourceRevision: "terraform-prod-eu-1"
      }
    })
  })

  it("rejects a cluster without an explicit maintenance context", async () => {
    const client = createMaintenanceControlPlaneClient({
      env: environment,
      fetchImplementation: async () =>
        new Response(JSON.stringify({ desiredReleaseId: "release-1" }), { status: 200 })
    })

    await expect(client.getRuntimeTarget("prod-eu")).rejects.toThrow(
      "Runtime Target is not configured"
    )
  })

  it("submits a typed job and sends the token only as authorization", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = []
    const client = createMaintenanceControlPlaneClient({
      env: environment,
      fetchImplementation: async (input, init = {}) => {
        requests.push({ url: String(input), init })
        return new Response(
          JSON.stringify({ operationId: "00000000-0000-0000-0000-000000000001" }),
          { status: 202, headers: { "content-type": "application/json" } }
        )
      }
    })

    const result = await client.submit(job, new Date("2026-08-24T15:00:00.000Z"))
    const request = requests[0]
    if (request === undefined) throw new Error("Expected a request")

    expect(result).toEqual({
      operationId: "00000000-0000-0000-0000-000000000001",
      executionId: "maintenance-1"
    })
    expect(request.url).toBe(
      "https://control-plane.example/v1/runtime-clusters/prod-eu/maintenance"
    )
    const headers = new Headers(request.init.headers)
    expect(headers.get("authorization")).toBe(`Bearer ${"t".repeat(32)}`)
    expect(headers.get("content-type")).toBe("application/json")
    expect(JSON.parse(String(request.init.body))).toMatchObject({
      idempotencyKey: "maintenance-1",
      executionId: "maintenance-1",
      command: job.command
    })
  })

  it("reads only content-free operation status", async () => {
    const operation: MaintenanceOperation = {
      id: "00000000-0000-0000-0000-000000000001",
      clusterId: "prod-eu",
      desiredGeneration: "2",
      type: "maintenance_job",
      status: "succeeded",
      executionId: "maintenance-1",
      requestedAt: "2026-08-24T14:00:00.000Z",
      deadlineAt: "2026-08-24T14:20:00.000Z",
      completedAt: "2026-08-24T14:01:00.000Z"
    }
    const client = createMaintenanceControlPlaneClient({
      env: environment,
      fetchImplementation: async () => new Response(JSON.stringify(operation), { status: 200 })
    })

    await expect(
      client.getOperation("prod-eu", "00000000-0000-0000-0000-000000000001")
    ).resolves.toEqual(operation)
  })
})
