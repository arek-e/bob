import {
  flushTelemetry,
  invocationTelemetryLayer,
  makeInvocationSpanProcessor,
  noopSpanProcessor,
  type Telemetry
} from "@bob/observability"
import { Effect, Layer, ManagedRuntime, Redacted } from "effect"

import type { EgressBindings } from "../src/egress/bindings.ts"
import type { IngressBindings } from "../src/ingress/bindings.ts"
import type { RuntimeLifecycle } from "../src/runtime.ts"
import type { SendblueWebhookPayload } from "../src/sendblue/webhook-schema.ts"

import { SendblueEgress, sendblueEgressLayer } from "../src/egress/composition.ts"
import {
  handleDeliveryReconciliationRequest as deliveryReconciliationEffect,
  handleInteractionRequest as interactionEffect,
  handleReconcileRequest as reconcileRequestEffect
} from "../src/egress/http.ts"
import { handleScheduledReconcile as scheduledReconcileEffect } from "../src/egress/provider-recovery.ts"
import { processOutboundJob as outboundJobEffect } from "../src/egress/queue.ts"
import { reconcileInboundHistory as reconcileInboundHistoryEffect } from "../src/egress/reconcile.ts"
import { SendblueIngress, sendblueIngressLayer } from "../src/ingress/composition.ts"
import { handleIngressHttp as ingressHttpEffect } from "../src/ingress/http.ts"
import { SendblueProvider, sendblueProviderTestLayer } from "../src/sendblue/provider.ts"

type TelemetryBindings = {
  readonly OTEL_EXPORTER_OTLP_ENDPOINT?: string
  readonly BOB_RELEASE_SHA?: string
}

type LegacyEgressBindings = EgressBindings &
  TelemetryBindings & {
    readonly SENDBLUE_API_KEY_ID?: string
    readonly SENDBLUE_API_SECRET_KEY?: string
  }

function telemetryLayer(bindings: TelemetryBindings, serviceName: string) {
  const processor =
    bindings.OTEL_EXPORTER_OTLP_ENDPOINT === undefined || bindings.BOB_RELEASE_SHA === undefined
      ? noopSpanProcessor
      : makeInvocationSpanProcessor({
          endpoint: bindings.OTEL_EXPORTER_OTLP_ENDPOINT,
          serviceName,
          serviceVersion: bindings.BOB_RELEASE_SHA,
          deploymentEnvironment: "test"
        })
  return { processor, layer: invocationTelemetryLayer({ processor }) }
}

function ingressRuntimeLayer(bindings: IngressBindings & TelemetryBindings) {
  const telemetry = telemetryLayer(bindings, "bob-sendblue-ingress")
  return Layer.merge(sendblueIngressLayer(bindings), telemetry.layer)
}

function egressRuntimeLayer(bindings: LegacyEgressBindings) {
  const telemetry = telemetryLayer(bindings, "bob-sendblue-egress")
  const completeBindings = {
    ...bindings,
    SENDBLUE_WEBHOOK_SIGNING_SECRET: bindings.SENDBLUE_WEBHOOK_SIGNING_SECRET ?? "s".repeat(64),
    SENDBLUE_FROM_NUMBER: bindings.SENDBLUE_FROM_NUMBER ?? "+46711111111",
    SENDBLUE_ALLOWED_USER_NUMBER: bindings.SENDBLUE_ALLOWED_USER_NUMBER ?? "+46700000000",
    SENDBLUE_STATUS_CALLBACK_URL:
      bindings.SENDBLUE_STATUS_CALLBACK_URL ?? "https://bob.example/webhooks/outbound",
    CORE_CALLER_SECRET: bindings.CORE_CALLER_SECRET
  }
  const testFetch: typeof globalThis.fetch = (input, init) => {
    const body = init?.body
    const normalizedBody = body instanceof Uint8Array ? new TextDecoder().decode(body) : body
    if (init === undefined || normalizedBody === undefined) return globalThis.fetch(input, init)
    return globalThis.fetch(input, { ...init, body: normalizedBody })
  }
  return Layer.mergeAll(
    sendblueEgressLayer(completeBindings),
    sendblueProviderTestLayer(
      {
        apiKeyId: bindings.SENDBLUE_API_KEY_ID ?? "test-key",
        apiSecretKey: Redacted.make(bindings.SENDBLUE_API_SECRET_KEY ?? "test-secret")
      },
      testFetch
    ),
    telemetry.layer
  )
}

export function handleIngressHttp(
  request: Request,
  bindings: IngressBindings & TelemetryBindings,
  context?: RuntimeLifecycle
) {
  return runIngress(ingressHttpEffect(request), bindings, context)
}

async function runIngress<A>(
  effect: Effect.Effect<A, never, SendblueIngress | Telemetry>,
  bindings: IngressBindings & TelemetryBindings,
  context?: RuntimeLifecycle
) {
  const runtime = ManagedRuntime.make(ingressRuntimeLayer(bindings))
  const result = await runtime.runPromise(effect)
  const finish = runtime.runPromise(flushTelemetry).finally(() => runtime.dispose())
  if (context === undefined) await finish
  else context.waitUntil(finish)
  return result as A
}

async function runEgress<A, E>(
  effect: Effect.Effect<A, E, SendblueEgress | SendblueProvider | Telemetry>,
  bindings: LegacyEgressBindings,
  context?: RuntimeLifecycle
) {
  const runtime = ManagedRuntime.make(egressRuntimeLayer(bindings))
  const result = await runtime.runPromise(effect)
  const finish = runtime.runPromise(flushTelemetry).finally(() => runtime.dispose())
  if (context === undefined) await finish
  else context.waitUntil(finish)
  return result
}

export function processOutboundJob(
  input: unknown,
  bindings: LegacyEgressBindings,
  context?: RuntimeLifecycle
) {
  return runEgress(outboundJobEffect(input), bindings, context)
}

export function handleInteractionRequest(request: Request, bindings: LegacyEgressBindings) {
  return runEgress(interactionEffect(request), bindings)
}

export function handleDeliveryReconciliationRequest(
  request: Request,
  bindings: LegacyEgressBindings
) {
  return runEgress(deliveryReconciliationEffect(request), bindings)
}

export function handleReconcileRequest(request: Request, bindings: LegacyEgressBindings) {
  return runEgress(reconcileRequestEffect(request), bindings)
}

export function handleScheduledReconcile(scheduledAt: Date, bindings: LegacyEgressBindings) {
  return runEgress(scheduledReconcileEffect(scheduledAt), {
    ...bindings,
    CORE_CALLER_SECRET: bindings.CORE_CALLER_SECRET ?? "c".repeat(64)
  })
}

export function reconcileInboundHistory(options: {
  readonly history: {
    readonly hasLine: (sendblueNumber: string) => Promise<boolean>
    readonly listInbound: (window: {
      readonly sendblueNumber: string
      readonly since: Date
      readonly until: Date
    }) => Promise<readonly SendblueWebhookPayload[]>
  }
  readonly sendblueNumber: string
  readonly ownerNumber: string
  readonly signingSecret: string
  readonly scheduledAt: Date
  readonly accept: (request: {
    readonly headers: Readonly<Record<string, string>>
    readonly body: string
    readonly signal?: AbortSignal
  }) => Promise<Response>
}) {
  const provider = SendblueProvider.of({
    hasLine: (number: string) => Effect.promise(() => options.history.hasLine(number)),
    listInbound: (window: {
      readonly sendblueNumber: string
      readonly since: Date
      readonly until: Date
    }) => Effect.promise(() => options.history.listInbound(window))
  } as never)
  return Effect.runPromise(
    reconcileInboundHistoryEffect(options).pipe(
      Effect.provide(Layer.succeed(SendblueProvider, provider))
    )
  )
}
