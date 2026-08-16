import type { InboundJob } from "@bob/core-types/jobs"
import type { JobPublisher } from "@bob/job-queue-types"

import { makeQueueBindingJobPublisher } from "@bob/job-queue-runtime/queue-binding"
import { noopSpanProcessor } from "@bob/observability/effect"
import {
  invocationEventSink,
  invocationTelemetryLayer,
  makeInvocationSpanProcessor
} from "@bob/observability/invocation"
import { Context, Effect, Layer, Schema } from "effect"

import type { RuntimeFetcher } from "../../src/runtime.ts"
import type { IngressBindings } from "./bindings.ts"

const ApplicationConfiguration = Schema.Struct({
  SENDBLUE_ACCOUNT_ID: Schema.String,
  SENDBLUE_LINE_ID: Schema.String,
  SENDBLUE_WEBHOOK_SIGNING_SECRET: Schema.String.check(Schema.isMinLength(32)),
  SENDBLUE_FROM_NUMBER: Schema.String.check(Schema.isPattern(/^\+[1-9]\d{7,14}$/)),
  SENDBLUE_ALLOWED_USER_NUMBER: Schema.String.check(Schema.isPattern(/^\+[1-9]\d{7,14}$/)),
  CORE_CALLER_SECRET: Schema.String.check(Schema.isMinLength(32))
})

const TelemetryConfiguration = Schema.Struct({
  OTEL_EXPORTER_OTLP_ENDPOINT: Schema.URLFromString,
  BOB_RELEASE_SHA: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/))
})

interface IngressPorts {
  readonly core: RuntimeFetcher
  readonly queue: JobPublisher<InboundJob>
}

const IngressPorts = Context.Service<IngressPorts>("bob/IngressPorts")

function telemetryProcessor(bindings: IngressBindings) {
  try {
    const config = Schema.decodeUnknownSync(TelemetryConfiguration)(bindings)
    return makeInvocationSpanProcessor({
      endpoint: config.OTEL_EXPORTER_OTLP_ENDPOINT.toString(),
      serviceName: "bob-sendblue-ingress",
      serviceVersion: config.BOB_RELEASE_SHA,
      deploymentEnvironment: "prod"
    })
  } catch {
    return noopSpanProcessor
  }
}

export function composeIngress(bindings: IngressBindings) {
  const config = Schema.decodeUnknownSync(ApplicationConfiguration)(bindings)
  const ports: IngressPorts = {
    core: bindings.CORE,
    queue: makeQueueBindingJobPublisher(bindings.INBOUND_QUEUE)
  }
  const events = invocationEventSink()
  const processor = telemetryProcessor(bindings)
  const layer = Layer.merge(
    Layer.succeed(IngressPorts, ports),
    invocationTelemetryLayer({ processor })
  )
  return {
    config,
    events,
    processor,
    ports: Effect.runSync(
      Effect.gen(function* () {
        return yield* IngressPorts
      }).pipe(Effect.provide(layer))
    ),
    layer
  }
}
