import type { OutboundJob } from "@bob/contracts/jobs"
import type { JobPublisher } from "@bob/job-queue"

import type { DeliveryStore } from "./store.ts"

export async function publishDeliveryFollowups(
  publisher: JobPublisher<OutboundJob>,
  delivery: DeliveryStore,
  outboxIds: readonly string[],
  correlationId: string
): Promise<void> {
  for (const outboxId of outboxIds) {
    await publisher.publish({ outboxId, correlationId } satisfies OutboundJob)
    await delivery.markEnqueued(outboxId, new Date().toISOString())
  }
}
