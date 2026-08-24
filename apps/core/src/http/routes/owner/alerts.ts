import { ConversationStore } from "@bob/conversations-types/store"
import { DeliveryReconciliationResponse } from "@bob/delivery-types/delivery"
import { DeliveryStore } from "@bob/delivery-types/store"
import { AlertStore } from "@bob/operations-types/alerts"
import { Effect, Schema } from "effect"

import type { OwnerHttpRouteContext } from "../../context.ts"

import { json } from "../../response.ts"

export async function handleOwnerAlerts(
  context: OwnerHttpRouteContext
): Promise<Response | undefined> {
  if (context.request.method === "GET" && context.url.pathname === "/api/alerts") {
    return json({
      alerts: await context.composition.runtime.runPromise(
        Effect.flatMap(AlertStore, (alerts) => alerts.list(context.ownerId))
      )
    })
  }

  const reconcile = context.url.pathname.match(/^\/api\/alerts\/([^/]+)\/reconcile$/)
  if (context.request.method !== "POST" || reconcile === null) return undefined

  context.idempotencyKey()
  const alertId = decodeURIComponent(reconcile[1]!)
  const alert = await context.composition.runtime.runPromise(
    Effect.flatMap(AlertStore, (alerts) => alerts.get(context.ownerId, alertId))
  )
  if (alert === undefined) return json({ code: "not_found" }, 404)
  await context.composition.runtime.runPromise(
    Effect.flatMap(AlertStore, (alerts) =>
      alerts.setState(context.ownerId, alert.id, "reconciling")
    )
  )

  if (alert.code === "inbound_exhausted") {
    const decision = await context.composition.runtime.runPromise(
      Effect.flatMap(ConversationStore, (conversations) =>
        conversations.prepareInboundRecovery(alert.objectId, 4)
      )
    )
    if (decision === "recover") {
      await context.jobQueue().inbound.publish({
        eventId: alert.objectId,
        enqueuedAt: new Date().toISOString()
      })
      await context.composition.runtime.runPromise(
        Effect.flatMap(ConversationStore, (conversations) =>
          conversations.markEnqueued(alert.objectId, new Date().toISOString())
        )
      )
      await context.composition.runtime.runPromise(
        Effect.flatMap(AlertStore, (alerts) =>
          alerts.setState(context.ownerId, alert.id, "resolved")
        )
      )
    }
    return json({ status: decision })
  }

  if (alert.code === "outbound_exhausted") {
    const decision = await context.composition.runtime.runPromise(
      Effect.flatMap(DeliveryStore, (delivery) =>
        delivery.prepareOutboundRecovery(alert.objectId, 4)
      )
    )
    if (decision.status === "recover") {
      await context.jobQueue().outbound.publish({
        outboxId: alert.objectId,
        dispatchGeneration: decision.dispatchGeneration,
        enqueuedAt: new Date().toISOString()
      })
      await context.composition.runtime.runPromise(
        Effect.flatMap(DeliveryStore, (delivery) =>
          delivery.markEnqueued(
            alert.objectId,
            new Date().toISOString(),
            decision.dispatchGeneration
          )
        )
      )
      await context.composition.runtime.runPromise(
        Effect.flatMap(AlertStore, (alerts) =>
          alerts.setState(context.ownerId, alert.id, "resolved")
        )
      )
    } else if (decision.status === "resolved") {
      await context.composition.runtime.runPromise(
        Effect.flatMap(AlertStore, (alerts) =>
          alerts.setState(context.ownerId, alert.id, "resolved")
        )
      )
    }
    return json({ status: decision.status })
  }

  if (alert.code === "delivery_uncertain" || alert.code === "delivery_result_exhausted") {
    let status = await context.composition.runtime.runPromise(
      Effect.flatMap(DeliveryStore, (delivery) => delivery.reconcileOutbox(alert.objectId))
    )
    if (status === "pending") {
      const target = await context.composition.runtime.runPromise(
        Effect.flatMap(DeliveryStore, (delivery) => delivery.reconciliationTarget(alert.objectId))
      )
      if (target !== undefined) {
        const response = await fetch(
          `${context.composition.config.CHANNEL_EGRESS_URL}/internal/delivery-reconciliation`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-bob-caller-token": context.composition.config.EGRESS_CALLER_SECRET
            },
            body: JSON.stringify(target),
            signal: AbortSignal.timeout(10_000)
          }
        )
        if (response.ok) {
          const provider = Schema.decodeUnknownSync(DeliveryReconciliationResponse)(
            await response.json()
          )
          if (provider.status === "resolved") {
            await context.composition.runtime.runPromise(
              Effect.flatMap(DeliveryStore, (delivery) => delivery.recordResult(provider.result))
            )
            status = await context.composition.runtime.runPromise(
              Effect.flatMap(DeliveryStore, (delivery) => delivery.reconcileOutbox(alert.objectId))
            )
          }
        }
      }
    }
    if (status === "resolved") {
      await context.composition.runtime.runPromise(
        Effect.flatMap(AlertStore, (alerts) =>
          alerts.setState(context.ownerId, alert.id, "resolved")
        )
      )
    }
    return json({ status })
  }

  if (alert.code === "agent_authentication_failed") {
    const response = await fetch(
      `${context.composition.config.AGENT_ADMIN_URL}/v1/admin/auth/status`,
      {
        headers: {
          "x-bob-caller-token": context.composition.config.AGENT_CALLER_SECRET
        }
      }
    )
    const status = Schema.decodeUnknownSync(
      Schema.Struct({ configured: Schema.optionalKey(Schema.Boolean) })
    )(await response.json())
    if (response.ok && status.configured === true) {
      await context.composition.runtime.runPromise(
        Effect.flatMap(AlertStore, (alerts) =>
          alerts.setState(context.ownerId, alert.id, "resolved")
        )
      )
    }
    return json({ status: status.configured === true ? "resolved" : "pending" })
  }

  await context.composition.runtime.runPromise(
    Effect.flatMap(AlertStore, (alerts) => alerts.setState(context.ownerId, alert.id, "resolved"))
  )
  return json({ status: "manual_action_required" })
}
