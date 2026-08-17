import { Effect } from "effect"

import type { HealthEvent } from "./events.ts"

import { flushTelemetry, telemetryLayer, type SafeSpanRecord } from "./effect.ts"
import { parseHealthEvent } from "./events.ts"

export function makeCaptureTelemetry(_resource: {
  readonly serviceName: string
  readonly serviceVersion: string
  readonly deploymentEnvironment: string
}) {
  const spans: SafeSpanRecord[] = []
  const health: HealthEvent[] = []
  const layer = telemetryLayer({
    processor: {
      onEnd: (span) => spans.push(span),
      forceFlush: Effect.void,
      shutdown: Effect.void
    },
    writeHealth: (event) => health.push(parseHealthEvent(event))
  })
  return {
    layer,
    flush: flushTelemetry,
    shutdown: async () => undefined,
    finishedSpans: (): ReadonlyArray<SafeSpanRecord> => [...spans],
    healthEvents: (): ReadonlyArray<HealthEvent> => [...health]
  }
}
