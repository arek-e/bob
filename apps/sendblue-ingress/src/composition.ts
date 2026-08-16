import type { InboundJob } from "@bob/contracts/jobs"
import type { JobPublisher } from "@bob/job-queue"

import { makeCloudflareJobPublisher } from "@bob/job-queue/cloudflare"
import {
  cloudflareEventSink,
  cloudflareTelemetryLayer,
  makeCloudflareSpanProcessor
} from "@bob/observability/cloudflare"
import { noopSpanProcessor } from "@bob/observability/effect"
import { Context, Effect, Layer, Schema } from "effect"

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
  OTEL_ACCESS_CLIENT_ID: Schema.String.check(Schema.isMinLength(1)),
  OTEL_ACCESS_CLIENT_SECRET: Schema.String.check(Schema.isMinLength(1)),
  BOB_RELEASE_SHA: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/))
})

interface IngressPorts {
  readonly core: Fetcher
  readonly queue: JobPublisher<InboundJob>
}

const IngressPorts = Context.Service<IngressPorts>("bob/IngressPorts")

function telemetryProcessor(bindings: IngressBindings) {
  try {
    const config = Schema.decodeUnknownSync(TelemetryConfiguration)(bindings)
    return makeCloudflareSpanProcessor({
      endpoint: config.OTEL_EXPORTER_OTLP_ENDPOINT.toString(),
      serviceName: "bob-sendblue-ingress",
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

export function composeIngress(bindings: IngressBindings) {
  const config = Schema.decodeUnknownSync(ApplicationConfiguration)(bindings)
  const ports: IngressPorts = {
    core: bindings.CORE,
    queue: makeCloudflareJobPublisher(bindings.INBOUND_QUEUE)
  }
  const events = cloudflareEventSink()
  const processor = telemetryProcessor(bindings)
  const layer = Layer.merge(
    Layer.succeed(IngressPorts, ports),
    cloudflareTelemetryLayer({ processor })
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
