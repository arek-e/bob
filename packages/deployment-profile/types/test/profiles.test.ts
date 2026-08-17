import { describe, expect, it } from "vitest"

import { coreDeploymentProfile, transitionalDeploymentProfile } from "../src/profiles.ts"

describe("Deployment Profile definitions", () => {
  it("preserves the reviewed profile identities and Capability Module order", () => {
    expect(coreDeploymentProfile.modules.map((module) => module.id)).toEqual(["memory", "settings"])
    expect(coreDeploymentProfile.generation).toBe("capability-v2:14603f15de62d729")

    expect(transitionalDeploymentProfile.modules.map((module) => module.id)).toEqual([
      "reminders",
      "memory",
      "journal",
      "training",
      "settings",
      "connections"
    ])
    expect(transitionalDeploymentProfile.generation).toBe("capability-v2:9491dc66605e345b")
  })
})
