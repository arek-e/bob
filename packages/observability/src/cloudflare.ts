import { Effect, Layer, Tracer } from "effect"

import type { EventSink, HealthEvent } from "./events.ts"

import { makeSafeTracer, type SafeSpanProcessor, Telemetry } from "./effect.ts"
import { parseHealthEvent } from "./events.ts"
import { makeOtlpHttpSpanProcessor, type OtlpHttpSpanProcessorOptions } from "./otlp.ts"

export function cloudflareEventSink(write: (line: string) => void = console.log): EventSink {
  return {
    emit(event: HealthEvent): void {
      write(JSON.stringify(parseHealthEvent(event)))
    }
  }
}

export type CloudflareSpanProcessorOptions = Omit<
  OtlpHttpSpanProcessorOptions,
  "scheduledDelayMs" | "flushOnShutdown"
>

export function makeCloudflareSpanProcessor(
  options: CloudflareSpanProcessorOptions
): SafeSpanProcessor {
  return makeOtlpHttpSpanProcessor(options)
}

export function cloudflareTelemetryLayer(options: {
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

export function flushCloudflareTelemetry(processor: SafeSpanProcessor): Effect.Effect<void> {
  return processor.forceFlush.pipe(Effect.catchCause(() => Effect.void))
}
