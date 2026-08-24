import { describe, expect, it } from "vitest"

import { isMaintenanceDiscoveryInvocation } from "../maintenance/discovery.js"

describe("maintenance entrypoint discovery", () => {
  it("recognizes context and help commands after shared options", () => {
    expect(isMaintenanceDiscoveryInvocation(["--context", "prod-eu", "context"])).toBe(true)
    expect(isMaintenanceDiscoveryInvocation(["--image", "a".repeat(64), "help"])).toBe(true)
  })

  it("keeps database commands on the Varlock path", () => {
    expect(isMaintenanceDiscoveryInvocation(["--context", "prod-eu", "migrate"])).toBe(false)
  })
})
