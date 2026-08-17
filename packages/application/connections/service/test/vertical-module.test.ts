import type { DeploymentProfileContext } from "@bob/deployment-profile-types/runtime"

import { describe, expect, it } from "vitest"

import { connectionsVerticalModule } from "../src/vertical-module.ts"

const context = (bindings: unknown) =>
  ({ bindings, database: {} }) as unknown as DeploymentProfileContext

describe("Connections Vertical Module", () => {
  it("prepares its complete runtime contribution set from owned configuration", () => {
    const prepared = connectionsVerticalModule.prepare(
      context({
        CONNECTIONS_GATEWAY_URL: "https://connections.example",
        CONNECTIONS_GATEWAY_CALLER_SECRET: "a-secure-caller-secret-with-32-characters"
      })
    )

    expect(prepared).toMatchObject({
      id: "connections",
      capability: { id: "connections" },
      evidenceSources: [],
      legacyArtifactReaders: [],
      deliveryTargets: []
    })
    expect(prepared.runtimeModules.conversations).toEqual([])
    expect(prepared.runtimeModules.ownerRoutes.map((route) => route.id)).toEqual([
      "connection-owner-routes"
    ])
    expect(prepared.runtimeModules.scheduledTasks).toEqual([])
    expect(prepared.toolAdapters.map((adapter) => adapter.capabilityId)).toEqual(["connections"])

    expect(() => connectionsVerticalModule.prepare(context({}))).toThrow()
  })
})
