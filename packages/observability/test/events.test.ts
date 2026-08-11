import { describe, expect, it } from "vitest"

import { parseHealthEvent } from "../src/events.ts"

describe("content-free telemetry", () => {
  it("rejects arbitrary content fields", () => {
    expect(() =>
      parseHealthEvent({
        type: "webhook",
        correlationId: "018e6f65-4d55-7a1b-8df4-4ee15ea1db9f",
        status: "accepted",
        code: "ok",
        durationMs: 3,
        messageText: "private"
      })
    ).toThrow()
  })
})
