import type { OutboundJob } from "@bob/core-types/jobs"
import type { JobPublisher } from "@bob/job-queue-types"

import { DeliveryStore } from "@bob/delivery-types/store"
import { Effect } from "effect"

export function publishDeliveryFollowups(
  publisher: JobPublisher<OutboundJob>,
  outboxIds: readonly string[],
  correlationId: string
) {
  return Effect.gen(function* () {
    const delivery = yield* DeliveryStore
    for (const outboxId of outboxIds) {
      yield* Effect.tryPromise({
        try: () =>
          publisher.publish({
            outboxId,
            dispatchGeneration: 0,
            correlationId
          } satisfies OutboundJob),
        catch: (cause) => cause
      })
      yield* delivery.markEnqueued(outboxId, new Date().toISOString(), 0)
    }
  })
}
