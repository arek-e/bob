import type { DeviceLoginEvent } from "@bob/contracts/agent"

export async function waitForDeviceLoginStart(
  event: Promise<DeviceLoginEvent>,
  timeoutMs: number
): Promise<DeviceLoginEvent> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      event,
      new Promise<DeviceLoginEvent>((resolve) => {
        timeout = setTimeout(
          () => resolve({ type: "failed", code: "device_login_start_timeout" }),
          Math.max(1, timeoutMs)
        )
      })
    ])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}
