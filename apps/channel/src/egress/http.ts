import { MessageInteractionCommand } from "@bob/conversations-types/interactions"
import { DeliveryReconciliationRequest, type DeliveryResult } from "@bob/delivery-types/delivery"
import { Effect, Schema } from "effect"

import { SendblueProvider, timingSafeEqual } from "../sendblue/provider.ts"
import { SendblueEgress } from "./composition.ts"
import { handleScheduledReconcile } from "./provider-recovery.ts"

function callerIsAuthorized(request: Request) {
  return Effect.gen(function* () {
    const egress = yield* SendblueEgress
    return yield* timingSafeEqual(
      request.headers.get("x-bob-caller-token") ?? "",
      egress.config.CORE_CALLER_SECRET
    )
  }).pipe(Effect.catch(() => Effect.succeed(false)))
}

function sha256Hex(value: string) {
  return Effect.promise(async () => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
  })
}

function deliveryState(status: string): "accepted" | "delivered" | "failed" {
  if (status === "DELIVERED") return "delivered"
  if (status === "DECLINED" || status === "ERROR" || status === "OPTED_OUT") return "failed"
  return "accepted"
}

export function handleInteractionRequest(request: Request) {
  return Effect.gen(function* () {
    if (!(yield* callerIsAuthorized(request))) {
      return Response.json({ error: "unauthorized" }, { status: 401 })
    }
    const command = yield* Effect.tryPromise(() => request.json()).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(MessageInteractionCommand)),
      Effect.catch(() => Effect.succeed(undefined))
    )
    if (command === undefined) return Response.json({ error: "invalid_request" }, { status: 400 })

    const sendblue = yield* SendblueProvider
    if (command.action === "stop") {
      const typing = yield* sendblue.sendTypingIndicator({
        number: command.number,
        fromNumber: command.fromNumber,
        state: "stop"
      })
      return Response.json({ typing })
    }
    // A typing indicator is enough feedback. A reaction before the reply
    // makes the assistant feel like it sent two responses.
    const typing = yield* sendblue.sendTypingIndicator({
      number: command.number,
      fromNumber: command.fromNumber,
      state: "start",
      maxDurationMs: command.maxDurationMs
    })
    return Response.json({ typing })
  })
}

export function handleDeliveryReconciliationRequest(request: Request) {
  return Effect.gen(function* () {
    if (!(yield* callerIsAuthorized(request))) {
      return Response.json({ error: "unauthorized" }, { status: 401 })
    }
    const target = yield* Effect.tryPromise(() => request.json()).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(DeliveryReconciliationRequest)),
      Effect.catch(() => Effect.succeed(undefined))
    )
    if (target === undefined) return Response.json({ error: "invalid_request" }, { status: 400 })

    const egress = yield* SendblueEgress
    const sendblue = yield* SendblueProvider
    let provider: ProviderDeliveryStatus
    if ("providerMessageHandle" in target) {
      const status = yield* sendblue.getStatus(target.providerMessageHandle)
      if (status.message_handle !== target.providerMessageHandle) {
        return Response.json({ status: "pending" })
      }
      provider = {
        messageHandle: status.message_handle,
        status: status.status,
        at: new Date().toISOString()
      }
    } else {
      const messages = yield* sendblue.listOutbound({
        sendblueNumber: egress.config.SENDBLUE_FROM_NUMBER,
        since: new Date(target.since),
        until: new Date(target.until)
      })
      const matches = []
      for (const message of messages) {
        if (
          message.is_outbound &&
          message.to_number === target.destinationE164 &&
          (yield* sha256Hex(message.content)) === target.payloadFingerprint
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
    const result: DeliveryResult = {
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
  }).pipe(Effect.catch(() => Effect.succeed(Response.json({ status: "pending" }, { status: 502 }))))
}

export function handleReconcileRequest(request: Request) {
  return Effect.gen(function* () {
    if (!(yield* callerIsAuthorized(request))) {
      return Response.json({ error: "unauthorized" }, { status: 401 })
    }
    return Response.json(yield* handleScheduledReconcile(new Date()))
  })
}

interface ProviderDeliveryStatus {
  readonly messageHandle: string
  readonly status: string
  readonly at: string
}
