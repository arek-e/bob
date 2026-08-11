import { InboundAcceptance, type NormalizedInboundEvent } from "@bob/contracts/channel"
import {
  formatTraceparent,
  observeSpan,
  parseTraceparent,
  traceContextFromCorrelationId,
  traceHeaders
} from "@bob/observability/trace"
import { acceptSendblueWebhook, WebhookRejection } from "@bob/sendblue/webhooks"
import { Schema } from "effect"

import type { IngressBindings } from "../bindings.ts"

import { composeIngress } from "../composition.ts"

const MAX_BODY_BYTES = 16 * 1024

function response(code: string, status: number): Response {
  return Response.json(
    { code },
    { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } }
  )
}

async function readJson(request: Request): Promise<unknown> {
  const declaredLength = Number(request.headers.get("content-length") ?? "0")
  if (declaredLength > MAX_BODY_BYTES) throw new Error("body_too_large")
  const bytes = new Uint8Array(await request.arrayBuffer())
  if (bytes.byteLength > MAX_BODY_BYTES) throw new Error("body_too_large")
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown
}

async function persistInbound(
  event: NormalizedInboundEvent,
  composition: ReturnType<typeof composeIngress>,
  trace: Parameters<typeof traceHeaders>[0]
): Promise<Response> {
  const stored = await composition.ports.core.fetch("https://core.internal/internal/inbound", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-bob-caller-token": composition.config.CORE_CALLER_SECRET,
      ...traceHeaders(trace),
      "x-bob-correlation-id": event.correlationId
    },
    body: JSON.stringify(event)
  })
  if (!stored.ok) return response("durable_store_failed", 503)
  const acceptance = Schema.decodeUnknownSync(InboundAcceptance)(await stored.json())
  if (acceptance.shouldEnqueue) {
    try {
      await composition.ports.queue.send({
        eventId: acceptance.eventId,
        traceparent: formatTraceparent(trace)
      })
    } catch {
      return response("queue_publish_failed", 503)
    }
    const marked = await composition.ports.core.fetch(
      `https://core.internal/internal/inbound/${encodeURIComponent(acceptance.eventId)}/enqueued`,
      {
        method: "POST",
        headers: { "x-bob-caller-token": composition.config.CORE_CALLER_SECRET }
      }
    )
    if (!marked.ok) return response("enqueue_record_failed", 503)
  }
  return response(acceptance.duplicate ? "duplicate" : "accepted", 202)
}

export async function handleIngressHttp(
  request: Request,
  bindings: IngressBindings
): Promise<Response> {
  const url = new URL(request.url)
  if (request.method === "GET" && url.pathname === "/health") {
    return Response.json({ healthy: true, service: "sendblue-ingress", version: 1 })
  }
  if (request.method !== "POST") return response("not_found", 404)

  const composition = composeIngress(bindings)
  try {
    const accepted = await acceptSendblueWebhook({
      pathname: url.pathname,
      suppliedSecret: request.headers.get("sb-signing-secret"),
      readPayload: () => readJson(request),
      policy: {
        signingSecret: composition.config.SENDBLUE_WEBHOOK_SIGNING_SECRET,
        accountId: composition.config.SENDBLUE_ACCOUNT_ID,
        lineId: composition.config.SENDBLUE_LINE_ID,
        fromNumber: composition.config.SENDBLUE_FROM_NUMBER,
        allowedUserNumber: composition.config.SENDBLUE_ALLOWED_USER_NUMBER
      },
      statusMetadata: {
        ...(url.searchParams.get("outbox_id") === null
          ? {}
          : { outboxId: url.searchParams.get("outbox_id")! }),
        ...(url.searchParams.get("attempt_id") === null
          ? {}
          : { attemptId: url.searchParams.get("attempt_id")! })
      }
    })
    if (accepted.kind === "inbound") {
      const event = accepted.event
      const startedAt = Date.now()
      const result = await observeSpan(
        {
          sink: composition.events,
          correlationId: event.correlationId,
          parent: traceContextFromCorrelationId(event.correlationId),
          name: "inbound.accept",
          feature: "assistant",
          workflow: "inbound_message",
          failureCode: "durable_store"
        },
        (trace) => persistInbound(event, composition, trace),
        (response) => (response.ok ? undefined : "durable_store")
      )
      const resultBody = (await result.clone().json()) as { code?: string }
      try {
        await composition.events.emit({
          type: "webhook",
          correlationId: event.correlationId,
          status:
            resultBody.code === "accepted"
              ? "accepted"
              : resultBody.code === "duplicate"
                ? "duplicate"
                : "failed",
          code: resultBody.code ?? "unknown",
          durationMs: Math.max(0, Date.now() - startedAt)
        })
      } catch {
        // Telemetry must not change webhook acceptance.
      }
      return result
    }
    if (accepted.kind === "status") {
      const event = accepted.event
      const stored = await observeSpan(
        {
          sink: composition.events,
          correlationId: event.correlationId,
          parent:
            parseTraceparent(url.searchParams.get("traceparent")) ??
            traceContextFromCorrelationId(event.correlationId),
          name: "provider.status",
          feature: "delivery",
          workflow: "outbound_delivery",
          failureCode: "durable_store"
        },
        (trace) =>
          composition.ports.core.fetch("https://core.internal/internal/status", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-bob-caller-token": composition.config.CORE_CALLER_SECRET,
              ...traceHeaders(trace),
              "x-bob-correlation-id": event.correlationId
            },
            body: JSON.stringify(event)
          }),
        (response) => (response.ok ? undefined : "durable_store")
      )
      return stored.ok ? response("accepted", 202) : response("durable_store_failed", 503)
    }
    return response("invalid_webhook", 400)
  } catch (error) {
    if (error instanceof WebhookRejection) return response(error.code, error.status)
    return response(
      error instanceof Error && error.message === "body_too_large"
        ? "body_too_large"
        : "invalid_webhook",
      error instanceof Error && error.message === "body_too_large" ? 413 : 400
    )
  }
}
