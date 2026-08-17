import type { InboundJob } from "@bob/core-types/jobs"
import type { JobPublisher } from "@bob/job-queue-types"

import { makeQueueBindingJobPublisher } from "@bob/job-queue-runtime/queue-binding"
import { Context, Effect, Layer, Schema } from "effect"

import type { RuntimeFetcher } from "../runtime.ts"
import type { IngressBindings } from "./bindings.ts"

const ApplicationConfiguration = Schema.Struct({
  SENDBLUE_ACCOUNT_ID: Schema.String,
  SENDBLUE_LINE_ID: Schema.String,
  SENDBLUE_WEBHOOK_SIGNING_SECRET: Schema.String.check(Schema.isMinLength(32)),
  SENDBLUE_FROM_NUMBER: Schema.String.check(Schema.isPattern(/^\+[1-9]\d{7,14}$/)),
  SENDBLUE_ALLOWED_USER_NUMBER: Schema.String.check(Schema.isPattern(/^\+[1-9]\d{7,14}$/)),
  CORE_CALLER_SECRET: Schema.String.check(Schema.isMinLength(32)),
  SENDBLUE_MEDIA_HOSTS: Schema.String.check(Schema.isMinLength(1))
})

export class SendblueIngress extends Context.Service<
  SendblueIngress,
  {
    readonly config: typeof ApplicationConfiguration.Type
    readonly core: RuntimeFetcher
    readonly media: RuntimeFetcher
    readonly allowedMediaHosts: ReadonlySet<string>
    readonly queue: JobPublisher<InboundJob>
  }
>()("bob/sendblue-channel/SendblueIngress") {}

export function sendblueIngressLayer(bindings: IngressBindings) {
  return Layer.effect(
    SendblueIngress,
    Schema.decodeUnknownEffect(ApplicationConfiguration)(bindings).pipe(
      Effect.map((config) =>
        SendblueIngress.of({
          config,
          core: bindings.CORE,
          media: bindings.MEDIA,
          allowedMediaHosts: new Set(
            config.SENDBLUE_MEDIA_HOSTS.split(",")
              .map((host) => host.trim().toLowerCase())
              .filter((host) => host.length > 0)
          ),
          queue: makeQueueBindingJobPublisher(bindings.INBOUND_QUEUE)
        })
      )
    )
  )
}
