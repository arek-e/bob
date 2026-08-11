import { cloudflareEventSink } from "@bob/observability/cloudflare"
import { createSendblueClient } from "@bob/sendblue/client"
import { Context, Effect, Layer, Schema } from "effect"

import type { EgressBindings } from "./bindings.ts"

const Configuration = Schema.Struct({
  SENDBLUE_API_KEY_ID: Schema.String,
  SENDBLUE_API_SECRET_KEY: Schema.String,
  SENDBLUE_STATUS_CALLBACK_URL: Schema.String,
  CORE_CALLER_SECRET: Schema.String.check(Schema.isMinLength(32))
})

interface EgressPorts {
  readonly core: Fetcher
  readonly sendblue: ReturnType<typeof createSendblueClient>
}
const EgressPorts = Context.Service<EgressPorts>("bob/EgressPorts")

export function composeEgress(bindings: EgressBindings) {
  const config = Schema.decodeUnknownSync(Configuration)(bindings)
  const events = cloudflareEventSink()
  const ports: EgressPorts = {
    core: bindings.CORE,
    sendblue: createSendblueClient({
      apiKeyId: config.SENDBLUE_API_KEY_ID,
      apiSecretKey: config.SENDBLUE_API_SECRET_KEY
    })
  }
  const layer = Layer.succeed(EgressPorts, ports)
  return {
    config,
    events,
    ports: Effect.runSync(
      Effect.gen(function* () {
        return yield* EgressPorts
      }).pipe(Effect.provide(layer))
    ),
    layer
  }
}
