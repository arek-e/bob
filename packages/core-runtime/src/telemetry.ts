import type { SafeSpanProcessor, Telemetry } from "@bob/observability/effect"

import {
  invocationTelemetryLayer,
  flushInvocationTelemetry,
  makeInvocationSpanProcessor
} from "@bob/observability/invocation"
import { Effect, type Layer } from "effect"

import type { CoreBindings } from "./bindings.ts"

export interface CoreTelemetryInvocation {
  readonly layer: Layer.Layer<Telemetry>
  readonly runPromise: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>
  readonly flush: () => Promise<void>
}

export interface TelemetryWaitUntil {
  readonly waitUntil: (promise: Promise<unknown>) => void
}

export function scheduleTelemetryWork(lifecycle: TelemetryWaitUntil, work: Promise<unknown>): void {
  try {
    lifecycle.waitUntil(work)
  } catch {
    void work.catch(() => undefined)
  }
}

function configured(bindings: CoreBindings): bindings is CoreBindings & {
  readonly BOB_RELEASE_SHA: string
  readonly OTEL_EXPORTER_OTLP_ENDPOINT: string
} {
  return (
    bindings.BOB_RELEASE_SHA !== undefined && bindings.OTEL_EXPORTER_OTLP_ENDPOINT !== undefined
  )
}

export function makeCoreTelemetryInvocation(bindings: CoreBindings): CoreTelemetryInvocation {
  const processor: SafeSpanProcessor = configured(bindings)
    ? makeInvocationSpanProcessor({
        endpoint: bindings.OTEL_EXPORTER_OTLP_ENDPOINT,
        serviceName: "bob-core-runtime",
        serviceVersion: bindings.BOB_RELEASE_SHA,
        deploymentEnvironment: "prod"
      })
    : {
        onEnd: () => undefined,
        forceFlush: Effect.void,
        shutdown: Effect.void
      }
  const layer = invocationTelemetryLayer({ processor })
  return {
    layer,
    runPromise: (effect) => Effect.runPromise(effect.pipe(Effect.provide(layer))),
    flush: () => Effect.runPromise(flushInvocationTelemetry(processor))
  }
}
