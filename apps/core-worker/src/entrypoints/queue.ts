import { DeliveryResult } from "@bob/contracts/delivery"
import { InboundJob } from "@bob/contracts/jobs"
import { Schema } from "effect"
import { eq } from "drizzle-orm"

import type { CoreBindings } from "../bindings.ts"
import { composeCore } from "../composition.ts"
import { outboxMessages } from "../modules/delivery/schema.ts"

export async function handleInboundQueue(
  batch: MessageBatch<unknown>,
  bindings: CoreBindings
): Promise<void> {
  const composition = composeCore(bindings)
  const isDeliveryResult =
    batch.queue === bindings.DELIVERY_RESULT_QUEUE_NAME ||
    batch.queue === bindings.DELIVERY_RESULT_DEAD_LETTER_QUEUE_NAME
  if (isDeliveryResult) {
    const isDeliveryResultDeadLetter =
      batch.queue === bindings.DELIVERY_RESULT_DEAD_LETTER_QUEUE_NAME
    for (const message of batch.messages) {
      try {
        const result = Schema.decodeUnknownSync(DeliveryResult)(message.body)
        if (isDeliveryResultDeadLetter) {
          const [outbox] = await composition.database
            .select({ userId: outboxMessages.userId })
            .from(outboxMessages)
            .where(eq(outboxMessages.id, result.outboxId))
            .limit(1)
          if (outbox !== undefined) {
            await composition.services.alerts.record({
              ownerId: outbox.userId,
              code: "delivery_result_exhausted",
              objectType: "outbox_message",
              objectId: result.outboxId,
              idempotencyKey: `alert:delivery-result-exhausted:${result.attemptId}`
            })
          }
        }
        await composition.services.delivery.recordResult(result)
        message.ack()
      } catch {
        message.retry({ delaySeconds: 60 })
      }
    }
    return
  }
  const isDeadLetter = batch.queue === bindings.INBOUND_DEAD_LETTER_QUEUE_NAME
  for (const message of batch.messages) {
    if (isDeadLetter) {
      let job: typeof InboundJob.Type
      try {
        job = Schema.decodeUnknownSync(InboundJob)(message.body)
      } catch {
        message.ack()
        continue
      }
      try {
        const ownerId = await composition.services.conversations.getInboundOwner(job.eventId)
        if (ownerId !== undefined) {
          await composition.services.alerts.record({
            ownerId,
            code: "inbound_exhausted",
            objectType: "inbound_event",
            objectId: job.eventId,
            idempotencyKey: `alert:inbound-exhausted:${job.eventId}`
          })
        }
        const decision = await composition.services.conversations.prepareInboundRecovery(
          job.eventId,
          3
        )
        if (decision === "recover") {
          await bindings.INBOUND_QUEUE.send(job, { delaySeconds: 300 })
          await composition.services.conversations.markEnqueued(
            job.eventId,
            new Date().toISOString()
          )
        }
        message.ack()
      } catch {
        message.retry({ delaySeconds: 60 })
      }
      continue
    }
    try {
      const job = Schema.decodeUnknownSync(InboundJob)(message.body)
      const ownerId = await composition.services.conversations.getInboundOwner(job.eventId)
      if (ownerId === undefined) {
        message.ack()
        continue
      }
      const euCoordinator = bindings.OWNER_RUN_COORDINATOR.jurisdiction("eu")
      const coordinator = euCoordinator.get(euCoordinator.idFromName(ownerId))
      const response = await coordinator.fetch("https://coordinator.internal/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(job)
      })
      if (!response.ok) throw new Error("owner_coordinator_failed")
      message.ack()
    } catch {
      message.retry({ delaySeconds: 30 })
    }
  }
}
