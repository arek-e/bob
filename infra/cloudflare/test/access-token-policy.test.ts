import { describe, expect, it } from "vitest"

import { validateAccessTokenRotation } from "../src/access-token-policy.ts"

describe("Access service-token rotation", () => {
  const now = new Date("2026-08-11T10:00:00.000Z")

  it("accepts a reviewed deadline inside the short token lifetime", () => {
    expect(() => validateAccessTokenRotation("2026-08-18T10:00:00.000Z", now)).not.toThrow()
  })

  it("rejects expired, immediate, and long-lived deadlines", () => {
    expect(() => validateAccessTokenRotation("2026-08-11T09:00:00.000Z", now)).toThrow()
    expect(() => validateAccessTokenRotation("2026-08-12T09:00:00.000Z", now)).toThrow()
    expect(() => validateAccessTokenRotation("2026-08-20T10:00:00.000Z", now)).toThrow()
  })
})
