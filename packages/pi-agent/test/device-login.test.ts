import { describe, expect, it, vi } from "vitest"

import { waitForDeviceLoginStart } from "../src/index.ts"

describe("device login", () => {
  it("returns a typed failure when Pi does not emit a start event", async () => {
    vi.useFakeTimers()
    try {
      const result = waitForDeviceLoginStart(new Promise(() => undefined), 5_000)
      await vi.advanceTimersByTimeAsync(5_000)

      await expect(result).resolves.toEqual({
        type: "failed",
        code: "device_login_start_timeout"
      })
    } finally {
      vi.useRealTimers()
    }
  })
})
