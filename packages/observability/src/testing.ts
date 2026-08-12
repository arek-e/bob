import { Effect } from "effect"

import type { EventSink, HealthEvent } from "./events.ts"

import { flushTelemetry, telemetryLayer, type SafeSpanRecord } from "./effect.ts"
import { parseHealthEvent } from "./events.ts"

export interface CapturedEvents extends EventSink {
  readonly events: readonly HealthEvent[]
}

export function captureEvents(): CapturedEvents {
  const events: HealthEvent[] = []
  return {
    get events() {
      return events
    },
    emit(event: HealthEvent): void {
      events.push(parseHealthEvent(event))
    }
  }
}

export function makeCaptureTelemetry(_resource: {
  readonly serviceName: string
  readonly serviceVersion: string
  readonly deploymentEnvironment: string
}) {
  const spans: SafeSpanRecord[] = []
  const health = captureEvents()
  const layer = telemetryLayer({
    processor: {
      onEnd: (span) => spans.push(span),
      forceFlush: Effect.void,
      shutdown: Effect.void
    },
    writeHealth: (event) => health.emit(event)
  })
  return {
    layer,
    flush: flushTelemetry,
    shutdown: async () => undefined,
    finishedSpans: (): ReadonlyArray<SafeSpanRecord> => [...spans],
    healthEvents: (): ReadonlyArray<HealthEvent> => [...health.events]
  }
}
