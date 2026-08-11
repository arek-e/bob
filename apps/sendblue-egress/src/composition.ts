import type { DeliveryResult } from "@bob/contracts/delivery"

import {
  cloudflareEventSink,
  cloudflareTelemetryLayer,
  makeCloudflareSpanProcessor
} from "@bob/observability/cloudflare"
import { noopSpanProcessor } from "@bob/observability/effect"
import { createSendblueClient } from "@bob/sendblue/client"
import { Context, Effect, Layer, Schema } from "effect"

import type { EgressBindings } from "./bindings.ts"

const ApplicationConfiguration = Schema.Struct({
  SENDBLUE_API_KEY_ID: Schema.String,
  SENDBLUE_API_SECRET_KEY: Schema.String,
  SENDBLUE_STATUS_CALLBACK_URL: Schema.String,
  CORE_CALLER_SECRET: Schema.String.check(Schema.isMinLength(32))
})

const TelemetryConfiguration = Schema.Struct({
  OTEL_EXPORTER_OTLP_ENDPOINT: Schema.URLFromString,
  OTEL_ACCESS_CLIENT_ID: Schema.String.check(Schema.isMinLength(1)),
  OTEL_ACCESS_CLIENT_SECRET: Schema.String.check(Schema.isMinLength(1)),
  BOB_RELEASE_SHA: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/))
})

interface EgressPorts {
  readonly core: Fetcher
  readonly deliveryResults: Queue<DeliveryResult>
  readonly sendblue: ReturnType<typeof createSendblueClient>
}
const EgressPorts = Context.Service<EgressPorts>("bob/EgressPorts")

function telemetryProcessor(bindings: EgressBindings) {
  try {
    const config = Schema.decodeUnknownSync(TelemetryConfiguration)(bindings)
    return makeCloudflareSpanProcessor({
      endpoint: config.OTEL_EXPORTER_OTLP_ENDPOINT.toString(),
      serviceName: "bob-sendblue-egress",
      serviceVersion: config.BOB_RELEASE_SHA,
      deploymentEnvironment: "prod",
      headers: {
        "CF-Access-Client-Id": config.OTEL_ACCESS_CLIENT_ID,
        "CF-Access-Client-Secret": config.OTEL_ACCESS_CLIENT_SECRET
      }
    })
  } catch {
    return noopSpanProcessor
  }
}

export function composeEgress(bindings: EgressBindings) {
  const config = Schema.decodeUnknownSync(ApplicationConfiguration)(bindings)
  const events = cloudflareEventSink()
  const ports: EgressPorts = {
    core: bindings.CORE,
    deliveryResults: bindings.DELIVERY_RESULT_QUEUE,
    sendblue: createSendblueClient({
      apiKeyId: config.SENDBLUE_API_KEY_ID,
      apiSecretKey: config.SENDBLUE_API_SECRET_KEY
    })
  }
  const processor = telemetryProcessor(bindings)
  const layer = Layer.merge(
    Layer.succeed(EgressPorts, ports),
    cloudflareTelemetryLayer({ processor })
  )
  return {
    config,
    events,
    processor,
    ports: Effect.runSync(
      Effect.gen(function* () {
        return yield* EgressPorts
      }).pipe(Effect.provide(layer))
    ),
    layer
  }
}
