import { InboundAcceptance, type NormalizedInboundEvent } from "@bob/conversations-types/channel"
import {
  emitHealth,
  externalParentFromTraceparent,
  injectCurrentTraceparent,
  recordDecision,
  withBobSpan
} from "@bob/observability"
import { Data, Effect, Schema } from "effect"

import { timingSafeEqual } from "../sendblue/provider.ts"
import { readSendblueStatusCallback } from "../sendblue/status-callback.ts"
import { decodeWebhookPayload, normalizeInbound, normalizeStatus } from "../sendblue/webhooks.ts"
import { SendblueIngress } from "./composition.ts"

const MAX_BODY_BYTES = 16 * 1024

class RequestBodyTooLargeError extends Data.TaggedError("RequestBodyTooLargeError") {
  override get message(): string {
    return "body_too_large"
  }
}

class WorkflowResponseFailure extends Schema.TaggedError<WorkflowResponseFailure>()(
  "WorkflowResponseFailure",
  { response: Schema.Defect() }
) {}

const response = (code: string, status: number): Response =>
  Response.json(
    { code },
    { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } }
  )

function readJson(request: Request) {
  return Effect.tryPromise({
    try: async () => {
      const declaredLength = Number(request.headers.get("content-length") ?? "0")
      if (declaredLength > MAX_BODY_BYTES) throw new RequestBodyTooLargeError()
      const bytes = new Uint8Array(await request.arrayBuffer())
      if (bytes.byteLength > MAX_BODY_BYTES) throw new RequestBodyTooLargeError()
      return JSON.parse(new TextDecoder().decode(bytes)) as unknown
    },
    catch: (cause) => cause
  })
}

function persistInbound(event: NormalizedInboundEvent) {
  return Effect.gen(function* () {
    const ingress = yield* SendblueIngress
    const stored = yield* withBobSpan(
      {
        name: "bob.inbound.invoke",
        correlationId: event.correlationId,
        feature: "assistant"
      },
      Effect.gen(function* () {
        const headers = yield* injectCurrentTraceparent({
          "content-type": "application/json",
          "x-bob-caller-token": ingress.config.CORE_CALLER_SECRET,
          "x-bob-correlation-id": event.correlationId
        })
        const result = yield* Effect.tryPromise(() =>
          ingress.core.fetch("https://core.internal/internal/inbound", {
            method: "POST",
            headers,
            body: JSON.stringify(event)
          })
        )
        if (!result.ok) return yield* new WorkflowResponseFailure({ response: result })
        return result
      })
    ).pipe(Effect.catch(() => Effect.succeed(response("durable_store_failed", 503))))
    if (!stored.ok) return response("durable_store_failed", 503)

    const acceptance = yield* Effect.tryPromise(() => stored.json()).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(InboundAcceptance)),
      Effect.catch(() => Effect.succeed(undefined))
    )
    if (acceptance === undefined) return response("durable_store_failed", 503)

    yield* recordDecision({
      name: "bob.decision.idempotency",
      code: acceptance.duplicate ? "replay" : "new",
      outcome: "selected"
    })
    if (acceptance.shouldEnqueue) {
      const published = yield* withBobSpan(
        {
          name: "bob.inbound.publish",
          correlationId: event.correlationId,
          feature: "assistant"
        },
        Effect.gen(function* () {
          const headers = yield* injectCurrentTraceparent()
          const traceparent = headers.get("traceparent")
          const job = {
            eventId: acceptance.eventId,
            correlationId: event.correlationId,
            ...(traceparent === null ? {} : { traceparent })
          }
          yield* Effect.tryPromise(() => ingress.queue.publish(job))
        })
      ).pipe(
        Effect.as(true),
        Effect.catch(() => Effect.succeed(false))
      )
      if (!published) return response("queue_publish_failed", 503)

      const marked = yield* withBobSpan(
        {
          name: "bob.inbound.confirm",
          correlationId: event.correlationId,
          feature: "assistant"
        },
        Effect.gen(function* () {
          const headers = yield* injectCurrentTraceparent({
            "x-bob-caller-token": ingress.config.CORE_CALLER_SECRET,
            "x-bob-correlation-id": event.correlationId
          })
          const result = yield* Effect.tryPromise(() =>
            ingress.core.fetch(
              `https://core.internal/internal/inbound/${encodeURIComponent(acceptance.eventId)}/enqueued`,
              { method: "POST", headers }
            )
          )
          if (!result.ok) return yield* new WorkflowResponseFailure({ response: result })
          return result
        })
      ).pipe(Effect.catch(() => Effect.succeed(response("enqueue_record_failed", 503))))
      if (!marked.ok) return response("enqueue_record_failed", 503)
    }
    return response(acceptance.duplicate ? "duplicate" : "accepted", 202)
  })
}

const receiveWebhook = (request: Request, payload: unknown) =>
  Effect.gen(function* () {
    const ingress = yield* SendblueIngress
    const decoded = yield* decodeWebhookPayload(payload)
    if (
      decoded.to_number !== ingress.config.SENDBLUE_FROM_NUMBER ||
      decoded.from_number !== ingress.config.SENDBLUE_ALLOWED_USER_NUMBER
    ) {
      return response("not_allowed", 403)
    }
    const event = yield* Effect.try({
      try: () =>
        normalizeInbound(decoded, {
          accountId: ingress.config.SENDBLUE_ACCOUNT_ID,
          lineId: ingress.config.SENDBLUE_LINE_ID
        }),
      catch: (cause) => cause
    })
    const startedAt = Date.now()
    const effect = withBobSpan(
      {
        name: "bob.webhook.receive",
        correlationId: event.correlationId,
        feature: "assistant"
      },
      persistInbound(event).pipe(
        Effect.flatMap((result) =>
          result.ok
            ? Effect.succeed(result)
            : Effect.fail(new WorkflowResponseFailure({ response: result }))
        )
      )
    )
    const parent = externalParentFromTraceparent(request.headers.get("traceparent"))
    const result = yield* (
      parent === undefined ? effect : effect.pipe(Effect.withParentSpan(parent))
    ).pipe(
      Effect.catchTag("WorkflowResponseFailure", (failure) =>
        Effect.succeed(failure.response as Response)
      )
    )
    const resultBody = yield* Effect.tryPromise(() => result.clone().json()).pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(Schema.Struct({ code: Schema.optionalKey(Schema.String) }))
      ),
      Effect.catch(() => Effect.succeed({ code: "unknown" }))
    )
    const healthCode =
      resultBody.code === "accepted" ||
      resultBody.code === "duplicate" ||
      resultBody.code === "durable_store_failed" ||
      resultBody.code === "queue_publish_failed" ||
      resultBody.code === "enqueue_record_failed"
        ? resultBody.code
        : "unknown"
    yield* emitHealth({
      type: "webhook",
      correlationId: event.correlationId,
      status:
        resultBody.code === "accepted"
          ? "accepted"
          : resultBody.code === "duplicate"
            ? "duplicate"
            : "failed",
      code: healthCode,
      durationMs: Math.max(0, Date.now() - startedAt)
    })
    return result
  })

const outboundWebhook = (request: Request, url: URL, payload: unknown) =>
  Effect.gen(function* () {
    const ingress = yield* SendblueIngress
    const decoded = yield* decodeWebhookPayload(payload)
    if (
      decoded.from_number !== ingress.config.SENDBLUE_FROM_NUMBER ||
      decoded.to_number !== ingress.config.SENDBLUE_ALLOWED_USER_NUMBER
    ) {
      return response("unknown_line", 403)
    }
    const callback = readSendblueStatusCallback(url)
    const isOptOut = decoded.opted_out || decoded.status === "OPTED_OUT"
    if (!isOptOut && (callback.outboxId === undefined || callback.attemptId === undefined)) {
      return response("ignored", 202)
    }
    const event = yield* Effect.try({
      try: () =>
        normalizeStatus(decoded, {
          accountId: ingress.config.SENDBLUE_ACCOUNT_ID,
          lineId: ingress.config.SENDBLUE_LINE_ID,
          ...callback
        }),
      catch: (cause) => cause
    })
    const spanInput = {
      name: "bob.delivery_result.invoke" as const,
      correlationId: event.correlationId,
      feature: "delivery" as const,
      ...(event.outboxId === undefined ? {} : { outboxId: event.outboxId }),
      ...(event.attemptId === undefined ? {} : { deliveryAttemptId: event.attemptId })
    }
    const effect = withBobSpan(
      {
        name: "bob.provider.status",
        correlationId: event.correlationId,
        feature: "delivery"
      },
      withBobSpan(
        spanInput,
        Effect.gen(function* () {
          const headers = yield* injectCurrentTraceparent({
            "content-type": "application/json",
            "x-bob-caller-token": ingress.config.CORE_CALLER_SECRET,
            "x-bob-correlation-id": event.correlationId
          })
          const result = yield* Effect.tryPromise(() =>
            ingress.core.fetch("https://core.internal/internal/status", {
              method: "POST",
              headers,
              body: JSON.stringify(event)
            })
          )
          if (!result.ok) return yield* new WorkflowResponseFailure({ response: result })
          return result
        })
      )
    )
    const parent =
      externalParentFromTraceparent(request.headers.get("traceparent")) ??
      externalParentFromTraceparent(callback.traceparent)
    const stored = yield* (
      parent === undefined ? effect : effect.pipe(Effect.withParentSpan(parent))
    ).pipe(
      Effect.catchTag("WorkflowResponseFailure", (failure) =>
        Effect.succeed(failure.response as Response)
      )
    )
    return stored.ok ? response("accepted", 202) : response("durable_store_failed", 503)
  })

export function handleIngressHttp(request: Request) {
  const url = new URL(request.url)
  if (request.method === "GET" && url.pathname === "/health") {
    return Effect.succeed(Response.json({ healthy: true, service: "sendblue-ingress", version: 1 }))
  }
  if (request.method !== "POST") return Effect.succeed(response("not_found", 404))

  return Effect.gen(function* () {
    const ingress = yield* SendblueIngress
    const suppliedSecret = request.headers.get("sb-signing-secret") ?? ""
    const authorized = yield* timingSafeEqual(
      suppliedSecret,
      ingress.config.SENDBLUE_WEBHOOK_SIGNING_SECRET
    ).pipe(Effect.catch(() => Effect.succeed(false)))
    if (!authorized) return response("unauthorized", 401)

    const payload = yield* readJson(request)
    if (url.pathname === "/webhooks/receive") return yield* receiveWebhook(request, payload)
    if (url.pathname === "/webhooks/outbound") {
      return yield* outboundWebhook(request, url, payload)
    }
    return response("not_found", 404)
  }).pipe(
    Effect.catch((cause) =>
      Effect.succeed(
        response(
          cause instanceof RequestBodyTooLargeError ? "body_too_large" : "invalid_webhook",
          cause instanceof RequestBodyTooLargeError ? 413 : 400
        )
      )
    )
  )
}
