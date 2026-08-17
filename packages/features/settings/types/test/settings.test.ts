import { Schema } from "effect"
import { describe, expect, it } from "vitest"

import { SettingsConnection } from "../src/settings.ts"

describe("settings connection contract", () => {
  it("keeps the provider identity opaque while preserving the wire field", () => {
    expect(
      Schema.decodeUnknownSync(SettingsConnection)({
        provider: "sendblue",
        status: "connected"
      })
    ).toEqual({ provider: "sendblue", status: "connected" })

    expect(
      Schema.decodeUnknownSync(SettingsConnection)({
        provider: "future-channel",
        status: "not_connected"
      })
    ).toEqual({ provider: "future-channel", status: "not_connected" })
  })
})
