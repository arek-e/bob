import { withBobSpan } from "@bob/observability/effect"
import { injectCurrentTraceparent } from "@bob/observability/propagation"
import { Effect } from "effect"

import type { CoreBindings } from "./bindings.ts"

import { handleHttp } from "./entrypoints/http.ts"
import { handleInboundQueue } from "./entrypoints/queue.ts"
import { handleScheduled } from "./entrypoints/scheduled.ts"
import { makeCoreTelemetryInvocation, scheduleTelemetryWork } from "./telemetry.ts"

export interface CoreWorkerDependencies {
  readonly handleHttp: typeof handleHttp
  readonly handleInboundQueue: typeof handleInboundQueue
  readonly handleScheduled: typeof handleScheduled
  readonly makeCoreTelemetryInvocation: typeof makeCoreTelemetryInvocation
}

const dependencies: CoreWorkerDependencies = {
  handleHttp,
  handleInboundQueue,
  handleScheduled,
  makeCoreTelemetryInvocation
}

export function createCoreWorker(input: CoreWorkerDependencies = dependencies) {
  return {
    fetch(request: Request, bindings: CoreBindings, context: ExecutionContext): Promise<Response> {
      const telemetry = input.makeCoreTelemetryInvocation(bindings)
      const response = input.handleHttp(request, bindings, undefined, telemetry)
      scheduleTelemetryWork(context, response.then(telemetry.flush, telemetry.flush))
      return response
    },
    queue(batch: MessageBatch<unknown>, bindings: CoreBindings, context: ExecutionContext) {
      const telemetry = input.makeCoreTelemetryInvocation(bindings)
      const processed = input.handleInboundQueue(batch, bindings, telemetry)
      scheduleTelemetryWork(context, processed.then(telemetry.flush, telemetry.flush))
      return processed
    },
    scheduled(controller: ScheduledController, bindings: CoreBindings, context: ExecutionContext) {
      const telemetry = input.makeCoreTelemetryInvocation(bindings)
      const correlationId = crypto.randomUUID()
      const scheduled = telemetry.runPromise(
        withBobSpan(
          { name: "bob.scheduled.run", correlationId, feature: "assistant" },
          Effect.gen(function* () {
            const headers = yield* injectCurrentTraceparent()
            const traceparent = headers.get("traceparent")
            yield* Effect.tryPromise({
              try: () => {
                const scheduledAt = new Date(controller.scheduledTime)
                return input.handleScheduled(
                  bindings,
                  traceparent === null
                    ? { correlationId, scheduledAt }
                    : { correlationId, scheduledAt, traceparent },
                  telemetry
                )
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
