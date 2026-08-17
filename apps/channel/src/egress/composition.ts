import type { DeliveryResult } from "@bob/delivery-types/delivery"
import type { JobPublisher } from "@bob/job-queue-types"

import { makeQueueBindingJobPublisher } from "@bob/job-queue-runtime/queue-binding"
import { Context, Effect, Layer, Schema } from "effect"

import type { RuntimeFetcher } from "../runtime.ts"
import type { EgressBindings } from "./bindings.ts"

const ApplicationConfiguration = Schema.Struct({
  SENDBLUE_WEBHOOK_SIGNING_SECRET: Schema.String.check(Schema.isMinLength(32)),
  SENDBLUE_FROM_NUMBER: Schema.String.check(Schema.isPattern(/^\+[1-9]\d{7,14}$/)),
  SENDBLUE_STATUS_CALLBACK_URL: Schema.URLFromString,
  CORE_CALLER_SECRET: Schema.String.check(Schema.isMinLength(32))
})

export class SendblueEgress extends Context.Service<
  SendblueEgress,
  {
    readonly config: typeof ApplicationConfiguration.Type
    readonly core: RuntimeFetcher
    readonly ingress: RuntimeFetcher
    readonly deliveryResults: JobPublisher<DeliveryResult>
  }
>()("bob/sendblue-channel/SendblueEgress") {}

export function sendblueEgressLayer(bindings: EgressBindings) {
  return Layer.effect(
    SendblueEgress,
    Schema.decodeUnknownEffect(ApplicationConfiguration)(bindings).pipe(
      Effect.map((config) =>
        SendblueEgress.of({
          config,
          core: bindings.CORE,
          ingress: bindings.INGRESS,
          deliveryResults: makeQueueBindingJobPublisher(bindings.DELIVERY_RESULT_QUEUE)
        })
      )
    )
  )
}
