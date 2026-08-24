import {
  ImageMediaType,
  MessageAttachmentReference,
  MessageAttachmentStore
} from "@bob/conversations-types/attachment-store"
import { NormalizedInboundEvent } from "@bob/conversations-types/channel"
import { ConversationStore } from "@bob/conversations-types/store"
import { withBobSpan, withTraceparent } from "@bob/observability"
import { Effect, Schema } from "effect"

import type { HttpRouteContext } from "../../context.ts"

import { json } from "../../response.ts"
import { attachmentFailureStatus } from "./attachments.ts"

export async function handleInternalConversations(
  context: HttpRouteContext
): Promise<Response | undefined> {
  if (context.request.method === "POST" && context.url.pathname === "/internal/inbound") {
    const event = Schema.decodeUnknownSync(NormalizedInboundEvent)(await context.readJson())
    const ownerId = await context.runTelemetry(
      Effect.flatMap(ConversationStore, (conversations) => conversations.resolveOwner(event))
    )
    if (ownerId === undefined) return json({ code: "channel_not_bound" }, 403)
    return json(
      await context.runTelemetry(
        withTraceparent(
          withBobSpan(
            {
              name: "bob.inbound.accept",
              correlationId: event.correlationId,
              feature: "assistant"
            },
            withBobSpan(
              {
                name: "bob.inbound.persist",
                correlationId: event.correlationId,
                feature: "assistant"
              },
              Effect.flatMap(ConversationStore, (conversations) =>
                conversations.acceptInbound(event, ownerId)
              )
            )
          ),
          context.request.headers.get("traceparent")
        )
      )
    )
  }

  const inboundAttachment = context.url.pathname.match(
    /^\/internal\/inbound\/([^/]+)\/attachments\/(\d+)$/
  )
  if (context.request.method === "PUT" && inboundAttachment !== null) {
    const eventId = Schema.decodeUnknownSync(Schema.String.check(Schema.isUUID()))(
      decodeURIComponent(inboundAttachment[1]!)
    )
    const ordinal = Schema.decodeUnknownSync(
      Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 0 }))
    )(Number(inboundAttachment[2]))
    const decodedMediaType = Schema.decodeUnknownExit(ImageMediaType)(
      context.request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
    )
    if (decodedMediaType._tag === "Failure") return json({ code: "invalid_media" }, 415)
    const body = await context.readAttachmentBytes()
    const stored = await context.runTelemetry(
      MessageAttachmentStore.use((store) =>
        store.storeInbound(eventId, ordinal, decodedMediaType.value, body)
      ).pipe(Effect.result)
    )
    if (stored._tag === "Failure") {
      const failure = stored.failure
      return json({ code: failure.code ?? "storage_failed" }, attachmentFailureStatus(failure))
    }
    return json(Schema.encodeSync(MessageAttachmentReference)(stored.success), 201)
  }

  const inboundEnqueued = context.url.pathname.match(/^\/internal\/inbound\/([^/]+)\/enqueued$/)
  if (context.request.method === "POST" && inboundEnqueued !== null) {
    const eventId = decodeURIComponent(inboundEnqueued[1]!)
    const correlationId = context.request.headers.get("x-bob-correlation-id") ?? eventId
    await context.runTelemetry(
      withTraceparent(
        withBobSpan(
          {
            name: "bob.inbound.confirm_accept",
            correlationId,
            feature: "assistant"
          },
          Effect.flatMap(ConversationStore, (conversations) =>
            conversations.markEnqueued(eventId, new Date().toISOString())
          )
        ),
        context.request.headers.get("traceparent")
      )
    )
    return json({ ok: true })
  }

  return undefined
}
