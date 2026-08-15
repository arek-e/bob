import type {
  EventSink,
  TelemetryFeature,
  TelemetrySpanCode,
  TelemetryWorkflow,
  WorkflowSpanName
} from "./events.ts"

export interface TraceContext {
  readonly traceId: string
  readonly spanId: string
  readonly traceFlags: "00" | "01"
}

export interface SpanInput {
  readonly sink: EventSink
  readonly correlationId: string
  readonly parent: TraceContext
  readonly name: WorkflowSpanName
  readonly feature: TelemetryFeature
  readonly workflow: TelemetryWorkflow
  readonly failureCode?: TelemetrySpanCode
  readonly errorCode?: (cause: unknown) => TelemetrySpanCode
  readonly now?: () => number
  readonly randomBytes?: (length: number) => Uint8Array
}

const traceparentPattern = /^00-([0-9a-f]{32})-([0-9a-f]{16})-(00|01)$/
const correlationPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function systemRandomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length))
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("")
}

function randomNonZeroHex(length: number, randomBytes: (length: number) => Uint8Array): string {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const value = toHex(randomBytes(length))
    if (!/^0+$/u.test(value)) return value
  }
  throw new Error("Trace identifier source returned only zero bytes")
}

export function parseTraceparent(value: string | null | undefined): TraceContext | undefined {
  if (value === null || value === undefined) return undefined
  const match = traceparentPattern.exec(value.trim().toLowerCase())
  if (match === null) return undefined
  const traceId = match[1]
  const spanId = match[2]
  const traceFlags = match[3]
  if (
    traceId === undefined ||
    spanId === undefined ||
    (traceFlags !== "00" && traceFlags !== "01") ||
    /^0+$/u.test(traceId) ||
    /^0+$/u.test(spanId)
  ) {
    return undefined
  }
  return { traceId, spanId, traceFlags }
}

export function formatTraceparent(context: TraceContext): string {
  const parsed = parseTraceparent(`00-${context.traceId}-${context.spanId}-${context.traceFlags}`)
  if (parsed === undefined) throw new TypeError("Trace context is invalid")
  return `00-${parsed.traceId}-${parsed.spanId}-${parsed.traceFlags}`
}

export function traceContextFromCorrelationId(
  correlationId: string,
  randomBytes: (length: number) => Uint8Array = systemRandomBytes
): TraceContext {
  if (!correlationPattern.test(correlationId)) throw new TypeError("Correlation ID is invalid")
  const traceId = correlationId.replaceAll("-", "").toLowerCase()
  return {
    traceId: /^0+$/u.test(traceId) ? randomNonZeroHex(16, randomBytes) : traceId,
    spanId: randomNonZeroHex(8, randomBytes),
    traceFlags: "01"
  }
}

export function childTraceContext(
  parent: TraceContext,
  randomBytes: (length: number) => Uint8Array = systemRandomBytes
): TraceContext {
  formatTraceparent(parent)
  return {
    traceId: parent.traceId,
    spanId: randomNonZeroHex(8, randomBytes),
    traceFlags: parent.traceFlags
  }
}

export interface TraceHeaders {
  readonly traceparent: string
}

export function traceHeaders(context: TraceContext): TraceHeaders {
  return { traceparent: formatTraceparent(context) }
}

async function emitSafely(sink: EventSink, event: Parameters<EventSink["emit"]>[0]) {
  try {
    await sink.emit(event)
  } catch {
    // Telemetry must not change the workflow result.
  }
}

export async function observeSpan<A>(
  input: SpanInput,
  operation: (context: TraceContext) => Promise<A>,
  resultCode?: (result: A) => TelemetrySpanCode | undefined
): Promise<A> {
  const now = input.now ?? Date.now
  const startedAt = now()
  const context = childTraceContext(input.parent, input.randomBytes)
  try {
    const result = await operation(context)
    const code = resultCode?.(result)
    await emitSafely(input.sink, {
      type: "workflow_span",
      correlationId: input.correlationId,
      traceId: context.traceId,
      spanId: context.spanId,
      parentSpanId: input.parent.spanId,
      name: input.name,
      feature: input.feature,
      workflow: input.workflow,
      status: code === undefined ? "completed" : "failed",
      code: code ?? "ok",
      durationMs: Math.max(0, Math.round(now() - startedAt))
    })
    return result
  } catch (error) {
    await emitSafely(input.sink, {
      type: "workflow_span",
      correlationId: input.correlationId,
      traceId: context.traceId,
      spanId: context.spanId,
      parentSpanId: input.parent.spanId,
      name: input.name,
      feature: input.feature,
      workflow: input.workflow,
      status: "failed",
      code: input.errorCode?.(error) ?? input.failureCode ?? "unknown",
      durationMs: Math.max(0, Math.round(now() - startedAt))
    })
    throw error
  }
}
