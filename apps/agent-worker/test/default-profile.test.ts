import { coreDeploymentProfile } from "@bob/core-types/profiles"
import { describe, expect, it } from "vitest"

import { defaultAgentProfile } from "../src/composition.ts"

describe("default Agent profile", () => {
  it("uses the same Core catalogue as the default Worker", () => {
    expect(defaultAgentProfile).toBe(coreDeploymentProfile)
    expect(defaultAgentProfile.profileId).toBe("core")
    expect(defaultAgentProfile.modules.map((module) => module.id)).toEqual(["memory", "settings"])
  })
})
