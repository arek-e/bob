import { it } from "@effect/vitest"
import { Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { expect } from "vitest"

import { waitForDeviceLoginStart } from "../src/internal/device-login.ts"

it.effect("returns a typed failure when Pi does not emit a start event", () =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(waitForDeviceLoginStart(Effect.never, 5_000))
    yield* TestClock.adjust(5_000)
    const result = yield* Fiber.join(fiber)
    expect(result).toEqual({ type: "failed", code: "device_login_start_timeout" })
  })
)
