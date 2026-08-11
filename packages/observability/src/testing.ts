import type { EventSink, HealthEvent } from "./events.ts"

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
