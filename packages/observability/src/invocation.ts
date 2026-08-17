import { Effect, Layer, Tracer } from "effect"

import type { SafeSpanProcessor } from "./effect.ts"
import type { HealthEvent } from "./events.ts"
import type { OtlpHttpSpanProcessorOptions } from "./otlp.ts"

import { makeSafeTracer, Telemetry } from "./effect.ts"
import { parseHealthEvent } from "./events.ts"
import { makeOtlpHttpSpanProcessor } from "./otlp.ts"

export type InvocationSpanProcessorOptions = Omit<
  OtlpHttpSpanProcessorOptions,
  "scheduledDelayMs" | "flushOnShutdown"
>

export function makeInvocationSpanProcessor(
  options: InvocationSpanProcessorOptions
): SafeSpanProcessor {
  return makeOtlpHttpSpanProcessor(options)
}

export function invocationTelemetryLayer(options: {
  readonly processor: SafeSpanProcessor
  readonly writeHealth?: (event: HealthEvent) => void
}): Layer.Layer<Telemetry> {
  const writeHealth =
    options.writeHealth ?? ((event: HealthEvent) => console.log(JSON.stringify(event)))
  const safeFlush = options.processor.forceFlush.pipe(Effect.catchCause(() => Effect.void))
  return Layer.merge(
    Layer.succeed(Tracer.Tracer, makeSafeTracer(options.processor)),
    Layer.succeed(Telemetry, {
      emitHealth: (event) =>
        Effect.sync(() => writeHealth(parseHealthEvent(event))).pipe(
          Effect.catchCause(() => Effect.void)
        ),
      flush: safeFlush
    })
  )
}

export function flushInvocationTelemetry(processor: SafeSpanProcessor): Effect.Effect<void> {
  return processor.forceFlush.pipe(Effect.catchCause(() => Effect.void))
}
