import type { DeliveryResult } from "@bob/delivery-types/delivery"
import type { JobPublisher } from "@bob/job-queue-types"

import { makeQueueBindingJobPublisher } from "@bob/job-queue-runtime/queue-binding"
import {
  noopSpanProcessor,
  invocationTelemetryLayer,
  makeInvocationSpanProcessor
} from "@bob/observability"
import { createSendblueClient } from "@bob/sendblue-runtime/client"
import { Context, Effect, Layer, Schema } from "effect"

import type { RuntimeFetcher } from "../../src/runtime.ts"
import type { EgressBindings } from "./bindings.ts"

const ApplicationConfiguration = Schema.Struct({
  SENDBLUE_API_KEY_ID: Schema.String,
  SENDBLUE_API_SECRET_KEY: Schema.String,
  SENDBLUE_STATUS_CALLBACK_URL: Schema.String,
  CORE_CALLER_SECRET: Schema.String.check(Schema.isMinLength(32))
})

const TelemetryConfiguration = Schema.Struct({
  OTEL_EXPORTER_OTLP_ENDPOINT: Schema.URLFromString,
  BOB_RELEASE_SHA: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/))
})

interface EgressPorts {
  readonly core: RuntimeFetcher
  readonly deliveryResults: JobPublisher<DeliveryResult>
  readonly sendblue: ReturnType<typeof createSendblueClient>
}
const EgressPorts = Context.Service<EgressPorts>("bob/EgressPorts")

function telemetryProcessor(bindings: EgressBindings) {
  try {
    const config = Schema.decodeUnknownSync(TelemetryConfiguration)(bindings)
    return makeInvocationSpanProcessor({
      endpoint: config.OTEL_EXPORTER_OTLP_ENDPOINT.toString(),
      serviceName: "bob-sendblue-egress",
      serviceVersion: config.BOB_RELEASE_SHA,
      deploymentEnvironment: "prod"
    })
  } catch {
    return noopSpanProcessor
  }
}

export function composeEgress(bindings: EgressBindings) {
  const config = Schema.decodeUnknownSync(ApplicationConfiguration)(bindings)
  const ports: EgressPorts = {
    core: bindings.CORE,
    deliveryResults: makeQueueBindingJobPublisher(bindings.DELIVERY_RESULT_QUEUE),
    sendblue: createSendblueClient({
      apiKeyId: config.SENDBLUE_API_KEY_ID,
      apiSecretKey: config.SENDBLUE_API_SECRET_KEY
    })
  }
  const processor = telemetryProcessor(bindings)
  const layer = Layer.merge(
    Layer.succeed(EgressPorts, ports),
    invocationTelemetryLayer({ processor })
  )
  return {
    config,
    processor,
    ports: Effect.runSync(
      Effect.gen(function* () {
        return yield* EgressPorts
      }).pipe(Effect.provide(layer))
    ),
    layer
  }
}
