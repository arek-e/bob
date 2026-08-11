import type { CoreBindings } from "./bindings.ts"
import { OwnerRunCoordinator, ReminderClock } from "./entrypoints/durable-objects.ts"
import { handleHttp } from "./entrypoints/http.ts"
import { handleInboundQueue } from "./entrypoints/queue.ts"
import { handleScheduled } from "./entrypoints/scheduled.ts"

export { OwnerRunCoordinator, ReminderClock }

export default {
  fetch(request: Request, bindings: CoreBindings): Promise<Response> {
    return handleHttp(request, bindings)
  },
  queue(batch: MessageBatch<unknown>, bindings: CoreBindings): Promise<void> {
    return handleInboundQueue(batch, bindings)
  },
  scheduled(
    _controller: ScheduledController,
    bindings: CoreBindings,
    context: ExecutionContext
  ): void {
    context.waitUntil(handleScheduled(bindings))
  }
} satisfies ExportedHandler<CoreBindings>
