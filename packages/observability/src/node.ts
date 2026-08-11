import type { EventSink, HealthEvent } from "./events.ts"
import { parseHealthEvent } from "./events.ts"

export function nodeEventSink(write: (line: string) => void = console.log): EventSink {
  return {
    emit(event: HealthEvent): void {
      write(JSON.stringify(parseHealthEvent(event)))
    }
  }
}
