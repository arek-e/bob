import type { DeploymentProfileContext } from "@bob/deployment-profile-types/runtime"

import { describe, expect, it } from "vitest"

import { coreRuntimeProfile, transitionalRuntimeProfile } from "../src/profiles.ts"

describe("Deployment Profile runtime views", () => {
  it("keeps the Core profile free of Vertical Modules", () => {
    expect(coreRuntimeProfile.verticalModules).toEqual([])
    expect(coreRuntimeProfile.catalogue.modules.map((module) => module.id)).toEqual([
      "memory",
      "settings"
    ])
  })

  it("matches each prepared Vertical Module to the definition view", () => {
    const catalogueVerticalIds = transitionalRuntimeProfile.catalogue.modules
      .map((module) => module.id)
      .filter((id) => !["memory", "settings"].includes(id))

    expect(transitionalRuntimeProfile.verticalModules.map((module) => module.id)).toEqual(
      catalogueVerticalIds
    )
    for (const module of transitionalRuntimeProfile.verticalModules) {
      expect(module.capability).toBe(
        transitionalRuntimeProfile.catalogue.modules.find(
          (capability) => capability.id === module.id
        )
      )
    }
  })

  it("prepares one complete static runtime view", () => {
    const contextFixture = {
      bindings: {
        CONNECTIONS_GATEWAY_URL: "https://connections.example",
        CONNECTIONS_GATEWAY_CALLER_SECRET: "a-secure-caller-secret-with-32-characters",
        UI_BASE_URL: "https://bob.example",
        REMINDER_CLOCK: { fetch: () => Promise.resolve(new Response()) },
        REMINDER_QUIET_HOURS_START: "22:00",
        REMINDER_QUIET_HOURS_END: "07:00",
        REMINDER_DAILY_LIMIT: 12
      },
      database: {},
      protection: {},
      ownerDataKeys: {},
      conversations: {},
      turns: {},
      settings: {},
      ownerId: "018e6f65-4d55-7a1b-8df4-4ee15ea1dba1",
      ownerTimeZone: "Europe/Stockholm"
    }
    // SAFETY: This test verifies assembly and does not execute infrastructure Adapters.
    const context = contextFixture as DeploymentProfileContext
    const prepared = transitionalRuntimeProfile.prepare(context)

    expect(prepared.verticalModules.map((module) => module.id)).toEqual([
      "reminders",
      "journal",
      "training",
      "connections"
    ])
    expect(prepared.toolAdapters.map((adapter) => adapter.capabilityId)).toEqual([
      "reminders",
      "journal",
      "training",
      "connections"
    ])
    for (const modules of Object.values(prepared.runtimeModules)) {
      const ids = modules.map((module) => module.id)
      expect(new Set(ids).size).toBe(ids.length)
    }
  })
})
