import type { OutboundJob } from "@bob/contracts/jobs"

import type { CoreBindings } from "../../bindings.ts"
import type { DeliveryStore } from "./store.ts"

export async function publishDeliveryFollowups(
  bindings: CoreBindings,
  delivery: DeliveryStore,
  outboxIds: readonly string[],
  correlationId: string
): Promise<void> {
  for (const outboxId of outboxIds) {
    await bindings.OUTBOUND_QUEUE.send({ outboxId, correlationId } satisfies OutboundJob)
    await delivery.markEnqueued(outboxId, new Date().toISOString())
  }
}
