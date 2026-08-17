import type { DeviceLoginEvent } from "@bob/agent-types/run"

import { Effect } from "effect"

export function waitForDeviceLoginStart(
  event: Effect.Effect<DeviceLoginEvent>,
  timeoutMs: number
): Effect.Effect<DeviceLoginEvent> {
  return event.pipe(
    Effect.timeoutOrElse({
      duration: Math.max(1, timeoutMs),
      orElse: () =>
        Effect.succeed({
          type: "failed" as const,
          code: "device_login_start_timeout" as const
        })
    })
  )
}
