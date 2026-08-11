import { OutboxClaim } from "@bob/contracts/delivery"
import { OutboundJob } from "@bob/contracts/jobs"
import { Schema } from "effect"

import type { EgressBindings } from "../bindings.ts"
import { composeEgress } from "../composition.ts"

export async function processOutboundJob(
  input: unknown,
  bindings: EgressBindings
): Promise<"done" | "retry"> {
  const job = Schema.decodeUnknownSync(OutboundJob)(input)
  const composition = composeEgress(bindings)
  const claimResponse = await composition.ports.core.fetch(
    `https://core.internal/internal/outbox/${encodeURIComponent(job.outboxId)}/claim`,
    {
      method: "POST",
      headers: { "x-bob-caller-token": composition.config.CORE_CALLER_SECRET }
    }
  )
  if (claimResponse.status === 409) {
    const conflict = (await claimResponse.json()) as { disposition?: string }
    return conflict.disposition === "active" ? "retry" : "done"
  }
  if (!claimResponse.ok) return "retry"
  const claim = Schema.decodeUnknownSync(OutboxClaim)(await claimResponse.json())
  const outcome = await composition.ports.sendblue.sendMessage(
    claim,
    `${composition.config.SENDBLUE_STATUS_CALLBACK_URL}?outbox_id=${encodeURIComponent(claim.outboxId)}&attempt_id=${encodeURIComponent(claim.attemptId)}`
  )
  const occurredAt = new Date().toISOString()
  const result =
    outcome.state === "accepted"
      ? {
          outboxId: claim.outboxId,
          attemptId: claim.attemptId,
          state: "accepted" as const,
          providerMessageHandle: outcome.providerMessageHandle,
          occurredAt
        }
      : {
          outboxId: claim.outboxId,
          attemptId: claim.attemptId,
          state: outcome.state,
          errorCode: outcome.code,
          occurredAt
        }
  try {
    await bindings.DELIVERY_RESULT_QUEUE.send(result)
    return "done"
  } catch {
    try {
      const recorded = await composition.ports.core.fetch(
        `https://core.internal/internal/outbox/${encodeURIComponent(job.outboxId)}/result`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-bob-caller-token": composition.config.CORE_CALLER_SECRET
          },
          body: JSON.stringify(result)
        }
      )
      return recorded.ok ? "done" : "retry"
    } catch {
      return "retry"
    }
  }
}

export async function handleOutboundQueue(
  batch: MessageBatch<unknown>,
  bindings: EgressBindings
): Promise<void> {
  for (const message of batch.messages) {
    try {
      const outcome = await processOutboundJob(message.body, bindings)
      if (outcome === "done") message.ack()
      else message.retry({ delaySeconds: 30 })
    } catch {
      message.retry({ delaySeconds: 30 })
    }
  }
}
