import { Effect, Tracer } from "effect"

export interface TraceparentContext {
  readonly traceId: string
  readonly spanId: string
  readonly sampled: boolean
}

const traceparentPattern = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/

function isZero(value: string): boolean {
  return /^0+$/u.test(value)
}

export function parseTraceparent(value: string | null | undefined): TraceparentContext | undefined {
  if (value === null || value === undefined) return undefined
  const match = traceparentPattern.exec(value.trim().toLowerCase())
  if (match === null || isZero(match[1]!) || isZero(match[2]!)) return undefined
  return {
    traceId: match[1]!,
    spanId: match[2]!,
    sampled: (Number.parseInt(match[3]!, 16) & 1) === 1
  }
}

export function formatTraceparent(
  context: Pick<Tracer.AnySpan, "traceId" | "spanId" | "sampled">
): string {
  const value = `00-${context.traceId.toLowerCase()}-${context.spanId.toLowerCase()}-${context.sampled ? "01" : "00"}`
  if (parseTraceparent(value) === undefined) throw new TypeError("Trace context is invalid")
  return value
}

export function externalParentFromTraceparent(
  value: string | null | undefined
): Tracer.ExternalSpan | undefined {
  const context = parseTraceparent(value)
  return context === undefined ? undefined : Tracer.externalSpan(context)
}

export function injectTraceparent(
  headers: HeadersInit | undefined,
  context: Pick<Tracer.AnySpan, "traceId" | "spanId" | "sampled">
): Headers {
  const output = new Headers(headers)
  output.set("traceparent", formatTraceparent(context))
  return output
}

export function injectCurrentTraceparent(headers?: HeadersInit): Effect.Effect<Headers> {
  return Effect.currentParentSpan.pipe(
    Effect.map((span) => injectTraceparent(headers, span)),
    Effect.catchTag("NoSuchElementError", () => Effect.succeed(new Headers(headers)))
  )
}
