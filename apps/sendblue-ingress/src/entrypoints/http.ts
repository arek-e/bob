import { InboundAcceptance, type NormalizedInboundEvent } from "@bob/contracts/channel"
import { flushCloudflareTelemetry } from "@bob/observability/cloudflare"
import { recordDecision, withBobSpan } from "@bob/observability/effect"
import { observeHealth } from "@bob/observability/events"
import {
  externalParentFromTraceparent,
  injectCurrentTraceparent
} from "@bob/observability/propagation"
import { readSendblueStatusCallback } from "@bob/sendblue/status-callback"
import {
  decodeWebhookPayload,
  normalizeInbound,
  normalizeStatus,
  timingSafeEqual
} from "@bob/sendblue/webhooks"
import { Effect, Schema, type Tracer } from "effect"

import type { IngressBindings } from "../bindings.ts"

import { composeIngress } from "../composition.ts"

const MAX_BODY_BYTES = 16 * 1024

class WorkflowResponseFailure {
  readonly _tag = "WorkflowResponseFailure"

  constructor(readonly response: Response) {}
}

function response(code: string, status: number): Response {
  return Response.json(
    { code },
    { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } }
  )
}

async function readJson(request: Request): Promise<typeof Schema.Json.Type> {
  const declaredLength = Number(request.headers.get("content-length") ?? "0")
  if (declaredLength > MAX_BODY_BYTES) throw new Error("body_too_large")
  const bytes = new Uint8Array(await request.arrayBuffer())
  if (bytes.byteLength > MAX_BODY_BYTES) throw new Error("body_too_large")
  return JSON.parse(new TextDecoder().decode(bytes))
}

function persistInbound(
  event: NormalizedInboundEvent,
  composition: ReturnType<typeof composeIngress>
) {
  return Effect.gen(function* () {
    const stored = yield* withBobSpan(
      {
        name: "bob.inbound.invoke",
        correlationId: event.correlationId,
        feature: "assistant"
      },
      Effect.gen(function* () {
        const headers = yield* injectCurrentTraceparent({
          "content-type": "application/json",
          "x-bob-caller-token": composition.config.CORE_CALLER_SECRET,
          "x-bob-correlation-id": event.correlationId
        })
        const response = yield* Effect.tryPromise(() =>
          composition.ports.core.fetch("https://core.internal/internal/inbound", {
            method: "POST",
            headers,
            body: JSON.stringify(event)
          })
        )
        if (!response.ok) return yield* Effect.fail(new WorkflowResponseFailure(response))
        return response
      })
    ).pipe(
      Effect.catchTag("WorkflowResponseFailure", (failure) => Effect.succeed(failure.response))
    )
    if (!stored.ok) return response("durable_store_failed", 503)
    const acceptance = yield* Effect.tryPromise(async () =>
      Schema.decodeUnknownSync(InboundAcceptance)(await stored.json())
    )
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
          yield* Effect.tryPromise(() => {
            const job = {
              eventId: acceptance.eventId,
              correlationId: event.correlationId
            }
            if (traceparent !== null) Object.assign(job, { traceparent })
            return composition.ports.queue.publish(job)
          })
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
            "x-bob-caller-token": composition.config.CORE_CALLER_SECRET,
            "x-bob-correlation-id": event.correlationId
          })
          const response = yield* Effect.tryPromise(() =>
            composition.ports.core.fetch(
              `https://core.internal/internal/inbound/${encodeURIComponent(acceptance.eventId)}/enqueued`,
              { method: "POST", headers }
            )
          )
          if (!response.ok) return yield* Effect.fail(new WorkflowResponseFailure(response))
          return response
        })
      ).pipe(
        Effect.catchTag("WorkflowResponseFailure", (failure) => Effect.succeed(failure.response))
      )
      if (!marked.ok) return response("enqueue_record_failed", 503)
    }
    return response(acceptance.duplicate ? "duplicate" : "accepted", 202)
  })
}

async function runTraced<A, E>(
  effect: Effect.Effect<A, E>,
  parent: Tracer.ExternalSpan | undefined,
  composition: ReturnType<typeof composeIngress>,
  context: ExecutionContext | undefined
): Promise<A> {
  const continued = parent === undefined ? effect : effect.pipe(Effect.withParentSpan(parent))
  try {
    return await Effect.runPromise(continued.pipe(Effect.provide(composition.layer)))
  } finally {
    if (context !== undefined) {
      try {
        context.waitUntil(Effect.runPromise(flushCloudflareTelemetry(composition.processor)))
      } catch {
        // Telemetry must not change webhook acceptance.
      }
    }
  }
}

export async function handleIngressHttp(
  request: Request,
  bindings: IngressBindings,
  context?: ExecutionContext
): Promise<Response> {
  const url = new URL(request.url)
  if (request.method === "GET" && url.pathname === "/health") {
    return Response.json({ healthy: true, service: "sendblue-ingress", version: 1 })
  }
  if (request.method !== "POST") return response("not_found", 404)

  const composition = composeIngress(bindings)
  const suppliedSecret = request.headers.get("sb-signing-secret")
  if (
    suppliedSecret === null ||
    !(await timingSafeEqual(suppliedSecret, composition.config.SENDBLUE_WEBHOOK_SIGNING_SECRET))
  ) {
    return response("unauthorized", 401)
  }

  try {
    const payload = decodeWebhookPayload(await readJson(request))
    if (url.pathname === "/webhooks/receive") {
      if (
        payload.to_number !== composition.config.SENDBLUE_FROM_NUMBER ||
        payload.from_number !== composition.config.SENDBLUE_ALLOWED_USER_NUMBER
      ) {
        return response("not_allowed", 403)
      }
      const event = normalizeInbound(payload, {
        accountId: composition.config.SENDBLUE_ACCOUNT_ID,
        lineId: composition.config.SENDBLUE_LINE_ID
      })
      const startedAt = Date.now()
      const result = await runTraced(
        withBobSpan(
          {
            name: "bob.webhook.receive",
            correlationId: event.correlationId,
            feature: "assistant"
          },
          Effect.gen(function* () {
            const result = yield* persistInbound(event, composition)
            if (!result.ok) return yield* Effect.fail(new WorkflowResponseFailure(result))
            return result
          })
        ).pipe(
          Effect.catchTag("WorkflowResponseFailure", (failure) => Effect.succeed(failure.response))
        ),
        externalParentFromTraceparent(request.headers.get("traceparent")),
        composition,
        context
      )
      const resultBody = Schema.decodeUnknownSync(
        Schema.Struct({ code: Schema.optionalKey(Schema.String) })
      )(await result.clone().json())
      const healthCode =
        resultBody.code === "accepted" ||
        resultBody.code === "duplicate" ||
        resultBody.code === "durable_store_failed" ||
        resultBody.code === "queue_publish_failed" ||
        resultBody.code === "enqueue_record_failed"
          ? resultBody.code
          : "unknown"
      await observeHealth(composition.events, {
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
    }
    if (url.pathname === "/webhooks/outbound") {
      if (
        payload.from_number !== composition.config.SENDBLUE_FROM_NUMBER ||
        payload.to_number !== composition.config.SENDBLUE_ALLOWED_USER_NUMBER
      ) {
        return response("unknown_line", 403)
      }
      const callback = readSendblueStatusCallback(url)
      const isOptOut = payload.opted_out || payload.status === "OPTED_OUT"
      if (!isOptOut && (callback.outboxId === undefined || callback.attemptId === undefined)) {
        return response("ignored", 202)
      }
      const event = normalizeStatus(payload, {
        accountId: composition.config.SENDBLUE_ACCOUNT_ID,
        lineId: composition.config.SENDBLUE_LINE_ID,
        ...callback
      })
      const stored = await runTraced(
        withBobSpan(
          {
            name: "bob.provider.status",
            correlationId: event.correlationId,
            feature: "delivery"
          },
          Effect.gen(function* () {
            const span = {
              name: "bob.delivery_result.invoke",
              correlationId: event.correlationId,
              feature: "delivery"
            } as const
            const spanInput = { ...span }
            if (event.outboxId !== undefined) Object.assign(spanInput, { outboxId: event.outboxId })
            if (event.attemptId !== undefined)
              Object.assign(spanInput, { deliveryAttemptId: event.attemptId })
            const response = yield* withBobSpan(
              spanInput,
              Effect.gen(function* () {
                const headers = yield* injectCurrentTraceparent({
                  "content-type": "application/json",
                  "x-bob-caller-token": composition.config.CORE_CALLER_SECRET,
                  "x-bob-correlation-id": event.correlationId
                })
                const response = yield* Effect.tryPromise(() =>
                  composition.ports.core.fetch("https://core.internal/internal/status", {
                    method: "POST",
                    headers,
                    body: JSON.stringify(event)
                  })
                )
                if (!response.ok) {
                  return yield* Effect.fail(new WorkflowResponseFailure(response))
                }
                return response
              })
            )
            return response
          })
        ).pipe(
          Effect.catchTag("WorkflowResponseFailure", (failure) => Effect.succeed(failure.response))
        ),
        externalParentFromTraceparent(request.headers.get("traceparent")) ??
          externalParentFromTraceparent(callback.traceparent),
        composition,
        context
      )
      return stored.ok ? response("accepted", 202) : response("durable_store_failed", 503)
    }
    return response("not_found", 404)
  } catch (error) {
    return response(
      error instanceof Error && error.message === "body_too_large"
        ? "body_too_large"
        : "invalid_webhook",
      error instanceof Error && error.message === "body_too_large" ? 413 : 400
    )
  }
}
