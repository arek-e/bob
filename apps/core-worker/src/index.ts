import { withBobSpan } from "@bob/observability/effect"
import { injectCurrentTraceparent } from "@bob/observability/propagation"
import { Effect } from "effect"

import type { CoreBindings } from "./bindings.ts"

import { OwnerRunCoordinator, ReminderClock } from "./entrypoints/durable-objects.ts"
import { handleHttp } from "./entrypoints/http.ts"
import { handleInboundQueue } from "./entrypoints/queue.ts"
import { handleScheduled } from "./entrypoints/scheduled.ts"
import { makeCoreTelemetryInvocation, scheduleTelemetryWork } from "./telemetry.ts"

export { OwnerRunCoordinator, ReminderClock }

export default {
  fetch(request: Request, bindings: CoreBindings, context: ExecutionContext): Promise<Response> {
    const telemetry = makeCoreTelemetryInvocation(bindings)
    const response = handleHttp(request, bindings, undefined, telemetry)
    scheduleTelemetryWork(context, response.then(telemetry.flush, telemetry.flush))
    return response
  },
  queue(
    batch: MessageBatch<unknown>,
    bindings: CoreBindings,
    context: ExecutionContext
  ): Promise<void> {
    const telemetry = makeCoreTelemetryInvocation(bindings)
    const processed = handleInboundQueue(batch, bindings, telemetry)
    scheduleTelemetryWork(context, processed.then(telemetry.flush, telemetry.flush))
    return processed
  },
  scheduled(
    controller: ScheduledController,
    bindings: CoreBindings,
    context: ExecutionContext
  ): void {
    const telemetry = makeCoreTelemetryInvocation(bindings)
    const correlationId = crypto.randomUUID()
    const scheduled = telemetry.runPromise(
      withBobSpan(
        {
          name: "bob.reminder.clock",
          correlationId,
          feature: "reminders"
        },
        Effect.gen(function* () {
          const headers = yield* injectCurrentTraceparent()
          const traceparent = headers.get("traceparent")
          yield* Effect.tryPromise({
            try: () =>
              handleScheduled(
                bindings,
                {
                  correlationId,
                  scheduledAt: new Date(controller.scheduledTime),
                  ...(traceparent === null ? {} : { traceparent })
                },
                telemetry
              ),
            catch: (error) => error
          })
        })
      )
    )
    scheduleTelemetryWork(context, scheduled.finally(telemetry.flush))
  }
} satisfies ExportedHandler<CoreBindings>
