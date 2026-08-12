import { Effect } from "effect"

import type { SafeSpanProcessor, SafeSpanRecord } from "./effect.ts"

export interface OtlpResource {
  readonly serviceName: string
  readonly serviceVersion: string
  readonly deploymentEnvironment: string
}

export type OtlpProcessorDiagnosticCode =
  | "queue_overflow"
  | "invalid_endpoint"
  | "invalid_configuration"
  | "http_4xx"
  | "http_5xx"
  | "http_other"
  | "export_timeout"
  | "network_error"

/** A content-free processor signal. Count is the number of affected spans. */
export interface OtlpProcessorDiagnostic {
  readonly code: OtlpProcessorDiagnosticCode
  readonly count: number
}

export interface OtlpProcessorDiagnosticEvent extends OtlpProcessorDiagnostic {
  readonly type: "otel_export"
}

export interface OtlpHttpSpanProcessorOptions extends OtlpResource {
  readonly endpoint: string
  readonly headers?: HeadersInit
  readonly fetch?: typeof fetch
  readonly timeoutMs?: number
  readonly maxQueueSize?: number
  readonly maxBatchSize?: number
  readonly scheduledDelayMs?: number
  readonly flushOnShutdown?: boolean
  readonly onDiagnostic?: (diagnostic: OtlpProcessorDiagnostic) => void
}

type OtlpValue =
  | { readonly stringValue: string }
  | { readonly boolValue: boolean }
  | { readonly intValue: string }
  | { readonly doubleValue: number }

function attribute(key: string, value: string | number | boolean) {
  let encoded: OtlpValue
  if (typeof value === "string") encoded = { stringValue: value }
  else if (typeof value === "boolean") encoded = { boolValue: value }
  else if (Number.isSafeInteger(value)) encoded = { intValue: String(value) }
  else encoded = { doubleValue: value }
  return { key, value: encoded }
}

const serviceNamePattern = /^bob-[a-z0-9]+(?:-[a-z0-9]+)*$/
const releaseShaPattern = /^[0-9a-f]{40}$/
const deploymentEnvironments = new Set(["prod", "test"])

function isSafeResource(resource: OtlpResource): boolean {
  return (
    resource.serviceName.length <= 64 &&
    serviceNamePattern.test(resource.serviceName) &&
    releaseShaPattern.test(resource.serviceVersion) &&
    deploymentEnvironments.has(resource.deploymentEnvironment)
  )
}

function resourceAttributes(resource: OtlpResource) {
  return [
    attribute("service.name", resource.serviceName),
    attribute("service.version", resource.serviceVersion),
    attribute("deployment.environment", resource.deploymentEnvironment),
    attribute("deployment.environment.name", resource.deploymentEnvironment),
    attribute("bob.release.sha", resource.serviceVersion)
  ]
}

const spanKinds = {
  internal: 1,
  server: 2,
  client: 3,
  producer: 4,
  consumer: 5
} as const

function otlpSpan(span: SafeSpanRecord) {
  return {
    traceId: span.traceId,
    spanId: span.spanId,
    ...(span.parentSpanId === undefined ? {} : { parentSpanId: span.parentSpanId }),
    name: span.name,
    kind: spanKinds[span.kind],
    startTimeUnixNano: span.startTimeUnixNano.toString(),
    endTimeUnixNano: span.endTimeUnixNano.toString(),
    attributes: Object.entries(span.attributes).map(([key, value]) => attribute(key, value)),
    events: span.events.map((event) => ({
      name: event.name,
      timeUnixNano: event.timeUnixNano.toString(),
      attributes: Object.entries(event.attributes).map(([key, value]) => attribute(key, value))
    })),
    status: { code: span.outcome === "completed" ? 1 : 2 },
    flags: span.sampled ? 1 : 0
  }
}

export function otlpTracePayload(spans: ReadonlyArray<SafeSpanRecord>, resource: OtlpResource) {
  if (!isSafeResource(resource)) return undefined
  return {
    resourceSpans: [
      {
        resource: { attributes: resourceAttributes(resource) },
        scopeSpans: [
          {
            scope: { name: "@bob/observability" },
            spans: spans.map(otlpSpan)
          }
        ]
      }
    ]
  }
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be positive`)
  return value
}

function traceEndpoint(value: string): string | undefined {
  try {
    const base = value.endsWith("/") ? value : `${value}/`
    return new URL("v1/traces", base).toString()
  } catch {
    return undefined
  }
}

function httpDiagnosticCode(status: number): OtlpProcessorDiagnosticCode {
  if (status >= 400 && status < 500) return "http_4xx"
  if (status >= 500 && status < 600) return "http_5xx"
  return "http_other"
}

export function makeOtlpHttpSpanProcessor(
  options: OtlpHttpSpanProcessorOptions
): SafeSpanProcessor {
  const request = options.fetch ?? fetch
  const endpoint = traceEndpoint(options.endpoint)
  const timeoutMs = positiveInteger(options.timeoutMs, 1_000, "Timeout")
  const maxQueueSize = positiveInteger(options.maxQueueSize, 512, "Queue size")
  const maxBatchSize = Math.min(
    maxQueueSize,
    positiveInteger(options.maxBatchSize, 128, "Batch size")
  )
  const queue: SafeSpanRecord[] = []
  let stopped = false
  let overflowCount = 0
  let pendingFlush: Promise<void> = Promise.resolve()

  const report = (code: OtlpProcessorDiagnosticCode, count: number): void => {
    try {
      const diagnostic = { code, count } satisfies OtlpProcessorDiagnostic
      if (options.onDiagnostic === undefined) {
        const event: OtlpProcessorDiagnosticEvent = { type: "otel_export", ...diagnostic }
        console.log(JSON.stringify(event))
      } else {
        options.onDiagnostic(diagnostic)
      }
    } catch {
      // Diagnostics must not change a workflow result.
    }
  }

  const send = async (batch: ReadonlyArray<SafeSpanRecord>): Promise<void> => {
    if (batch.length === 0) return
    if (endpoint === undefined) {
      report("invalid_endpoint", batch.length)
      return
    }
    const payload = otlpTracePayload(batch, options)
    if (payload === undefined) {
      report("invalid_configuration", batch.length)
      return
    }
    let response: Response | undefined
    let signal: AbortSignal | undefined
    try {
      const headers = new Headers(options.headers)
      headers.set("content-type", "application/json")
      signal = AbortSignal.timeout(timeoutMs)
      response = await request(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal
      })
      if (!response.ok) report(httpDiagnosticCode(response.status), batch.length)
    } catch (error) {
      const timedOut =
        signal?.aborted === true ||
        (typeof error === "object" &&
          error !== null &&
          Reflect.get(error, "name") === "TimeoutError")
      report(timedOut ? "export_timeout" : "network_error", batch.length)
    } finally {
      try {
        await response?.body?.cancel()
      } catch {
        // Collector response data is never part of application telemetry.
      }
    }
  }

  const drain = (all: boolean): Promise<void> => {
    const run = async () => {
      if (overflowCount > 0) {
        const count = overflowCount
        overflowCount = 0
        report("queue_overflow", count)
      }
      do {
        const batch = queue.splice(0, maxBatchSize)
        if (batch.length === 0) return
        await send(batch)
      } while (all)
    }
    pendingFlush = pendingFlush.then(run, run)
    return pendingFlush
  }

  const forceFlush = Effect.promise(() => drain(true)).pipe(Effect.catch(() => Effect.void))
  const scheduledDelayMs = options.scheduledDelayMs
  const interval =
    scheduledDelayMs === undefined
      ? undefined
      : setInterval(
          () => {
            void drain(false)
          },
          positiveInteger(scheduledDelayMs, 5_000, "Scheduled delay")
        )

  return {
    onEnd(span) {
      if (stopped || !span.sampled) return
      if (queue.length >= maxQueueSize) {
        overflowCount = Math.min(Number.MAX_SAFE_INTEGER, overflowCount + 1)
        return
      }
      queue.push(span)
    },
    forceFlush,
    shutdown: Effect.suspend(() => {
      if (stopped) return Effect.void
      stopped = true
      if (interval !== undefined) clearInterval(interval)
      if (options.flushOnShutdown === false) {
        queue.length = 0
        overflowCount = 0
        return Effect.void
      }
      return forceFlush
    })
  }
}
