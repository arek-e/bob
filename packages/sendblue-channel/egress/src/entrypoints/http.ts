import { DeliveryReconciliationRequest } from "@bob/core-types/delivery"
import { MessageInteractionCommand } from "@bob/core-types/interactions"
import { createSendblueHistoryClient } from "@bob/sendblue-runtime/history"
import { timingSafeEqual } from "@bob/sendblue-types/webhooks"
import { Schema } from "effect"

import type { EgressBindings } from "../bindings.ts"

import { composeEgress } from "../composition.ts"
import { handleScheduledReconcile } from "./provider-recovery.ts"

async function callerIsAuthorized(request: Request, bindings: EgressBindings): Promise<boolean> {
  const callerToken = request.headers.get("x-bob-caller-token") ?? ""
  return timingSafeEqual(callerToken, bindings.CORE_CALLER_SECRET)
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

function deliveryState(status: string): "accepted" | "delivered" | "failed" {
  if (status === "DELIVERED") return "delivered"
  if (status === "DECLINED" || status === "ERROR" || status === "OPTED_OUT") return "failed"
  return "accepted"
}

export async function handleInteractionRequest(
  request: Request,
  bindings: EgressBindings
): Promise<Response> {
  if (!(await callerIsAuthorized(request, bindings))) {
    return Response.json({ error: "unauthorized" }, { status: 401 })
  }

  let command: MessageInteractionCommand
  try {
    command = Schema.decodeUnknownSync(MessageInteractionCommand)(await request.json())
  } catch {
    return Response.json({ error: "invalid_request" }, { status: 400 })
  }

  const client = composeEgress(bindings).ports.sendblue
  if (command.action === "stop") {
    const typing = await client.sendTypingIndicator({
      number: command.number,
      fromNumber: command.fromNumber,
      state: "stop"
    })
    return Response.json({ typing })
  }

  const [reaction, typing] = await Promise.all([
    command.react
      ? client.sendReaction({
          fromNumber: command.fromNumber,
          messageHandle: command.messageHandle,
          reaction: "like"
        })
      : Promise.resolve({ state: "skipped" as const }),
    client.sendTypingIndicator({
      number: command.number,
      fromNumber: command.fromNumber,
      state: "start",
      maxDurationMs: command.maxDurationMs
    })
  ])
  return Response.json({ reaction, typing })
}

export async function handleDeliveryReconciliationRequest(
  request: Request,
  bindings: EgressBindings
): Promise<Response> {
  if (!(await callerIsAuthorized(request, bindings))) {
    return Response.json({ error: "unauthorized" }, { status: 401 })
  }
  let target: typeof DeliveryReconciliationRequest.Type
  try {
    target = Schema.decodeUnknownSync(DeliveryReconciliationRequest)(await request.json())
  } catch {
    return Response.json({ error: "invalid_request" }, { status: 400 })
  }
  try {
    const composition = composeEgress(bindings)
    let provider: ProviderDeliveryStatus
    if ("providerMessageHandle" in target) {
      const status = await composition.ports.sendblue.getStatus(target.providerMessageHandle)
      if (status.message_handle !== target.providerMessageHandle) {
        return Response.json({ status: "pending" })
      }
      provider = {
        messageHandle: status.message_handle,
        status: status.status,
        at: new Date().toISOString()
      }
    } else {
      const history = createSendblueHistoryClient({
        apiKeyId: bindings.SENDBLUE_API_KEY_ID,
        apiSecretKey: bindings.SENDBLUE_API_SECRET_KEY
      })
      const messages = await history.listOutbound({
        sendblueNumber: bindings.SENDBLUE_FROM_NUMBER,
        since: new Date(target.since),
        until: new Date(target.until)
      })
      const matches = []
      for (const message of messages) {
        if (
          message.is_outbound &&
          message.to_number === target.destinationE164 &&
          (await sha256Hex(message.content)) === target.payloadFingerprint
        ) {
          matches.push(message)
        }
      }
      if (matches.length !== 1 || matches[0] === undefined) {
        return Response.json({ status: "pending" })
      }
      provider = {
        messageHandle: matches[0].message_handle,
        status: matches[0].status,
        at: new Date(matches[0].date_updated).toISOString()
      }
    }
    const state = deliveryState(provider.status)
    const result = {
      outboxId: target.outboxId,
      attemptId: target.attemptId,
      correlationId: target.correlationId,
      state,
      providerMessageHandle: provider.messageHandle,
      occurredAt: provider.at
    }
    if (state === "failed") Object.assign(result, { errorCode: provider.status.toLowerCase() })
    return Response.json({
      status: "resolved",
      result
    })
  } catch {
    return Response.json({ status: "pending" }, { status: 502 })
  }
}

export async function handleReconcileRequest(
  request: Request,
  bindings: EgressBindings
): Promise<Response> {
  if (!(await callerIsAuthorized(request, bindings))) {
    return Response.json({ error: "unauthorized" }, { status: 401 })
  }

  const result = await handleScheduledReconcile(new Date(), bindings)
  return Response.json(result)
}
interface ProviderDeliveryStatus {
  readonly messageHandle: string
  readonly status: string
  readonly at: string
}
