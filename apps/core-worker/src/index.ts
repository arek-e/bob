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

export interface CoreWorkerDependencies {
  readonly handleHttp: typeof handleHttp
  readonly handleInboundQueue: typeof handleInboundQueue
  readonly handleScheduled: typeof handleScheduled
  readonly makeCoreTelemetryInvocation: typeof makeCoreTelemetryInvocation
}

const coreWorkerDependencies: CoreWorkerDependencies = {
  handleHttp,
  handleInboundQueue,
  handleScheduled,
  makeCoreTelemetryInvocation
}

export function createCoreWorker(dependencies: CoreWorkerDependencies = coreWorkerDependencies) {
  return {
    fetch(request: Request, bindings: CoreBindings, context: ExecutionContext): Promise<Response> {
      const telemetry = dependencies.makeCoreTelemetryInvocation(bindings)
      const response = dependencies.handleHttp(request, bindings, undefined, telemetry)
      scheduleTelemetryWork(context, response.then(telemetry.flush, telemetry.flush))
      return response
    },
    queue(
      batch: MessageBatch<unknown>,
      bindings: CoreBindings,
      context: ExecutionContext
    ): Promise<void> {
      const telemetry = dependencies.makeCoreTelemetryInvocation(bindings)
      const processed = dependencies.handleInboundQueue(batch, bindings, telemetry)
      scheduleTelemetryWork(context, processed.then(telemetry.flush, telemetry.flush))
      return processed
    },
    scheduled(
      controller: ScheduledController,
      bindings: CoreBindings,
      context: ExecutionContext
    ): void {
      const telemetry = dependencies.makeCoreTelemetryInvocation(bindings)
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
              try: () => {
                const scheduledAt = new Date(controller.scheduledTime)
                const input =
                  traceparent === null
                    ? { correlationId, scheduledAt }
                    : { correlationId, scheduledAt, traceparent }
                return dependencies.handleScheduled(bindings, input, telemetry)
              },
              catch: (error) => error
            })
          })
        )
      )
      scheduleTelemetryWork(context, scheduled.finally(telemetry.flush))
    }
  } satisfies ExportedHandler<CoreBindings>
}

export default createCoreWorker()
