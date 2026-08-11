import type { InboundJob } from "@bob/contracts/jobs"

import { cloudflareEventSink } from "@bob/observability/cloudflare"
import { Context, Effect, Layer, Schema } from "effect"

import type { IngressBindings } from "./bindings.ts"

const Configuration = Schema.Struct({
  SENDBLUE_ACCOUNT_ID: Schema.String,
  SENDBLUE_LINE_ID: Schema.String,
  SENDBLUE_WEBHOOK_SIGNING_SECRET: Schema.String.check(Schema.isMinLength(32)),
  SENDBLUE_FROM_NUMBER: Schema.String.check(Schema.isPattern(/^\+[1-9]\d{7,14}$/)),
  SENDBLUE_ALLOWED_USER_NUMBER: Schema.String.check(Schema.isPattern(/^\+[1-9]\d{7,14}$/)),
  CORE_CALLER_SECRET: Schema.String.check(Schema.isMinLength(32))
})

interface IngressPorts {
  readonly core: Fetcher
  readonly queue: Queue<InboundJob>
}

const IngressPorts = Context.Service<IngressPorts>("bob/IngressPorts")

export function composeIngress(bindings: IngressBindings) {
  const config = Schema.decodeUnknownSync(Configuration)(bindings)
  const ports: IngressPorts = { core: bindings.CORE, queue: bindings.INBOUND_QUEUE }
  const events = cloudflareEventSink()
  const layer = Layer.succeed(IngressPorts, ports)
  return {
    config,
    events,
    ports: Effect.runSync(
      Effect.gen(function* () {
        return yield* IngressPorts
      }).pipe(Effect.provide(layer))
    ),
    layer
  }
}
