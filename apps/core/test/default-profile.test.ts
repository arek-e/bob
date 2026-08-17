import { describe, expect, it } from "vitest"

import { defaultRuntimeProfile } from "../src/composition.ts"

describe("Core default Deployment Profile", () => {
  it("uses the Core definition and no Vertical Modules", () => {
    expect(defaultRuntimeProfile.catalogue.profileId).toBe("core")
    expect(defaultRuntimeProfile.catalogue.generation).toBe("capability-v2:14603f15de62d729")
    expect(defaultRuntimeProfile.verticalModules).toEqual([])
  })
})
