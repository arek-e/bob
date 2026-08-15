import { Layer } from "effect"
import { AsyncLocalStorage } from "node:async_hooks"

import { telemetryLayer, type Telemetry } from "./effect.ts"
import {
  parseHealthEvent,
  type EventSink,
  type HealthEvent,
  TelemetryFeature,
  TelemetrySpanCode,
  TelemetryWorkflow,
  WorkflowSpanName
} from "./events.ts"
import { makeOtlpHttpSpanProcessor, type OtlpHttpSpanProcessorOptions } from "./otlp.ts"
import { observeSpan, type SpanInput, type TraceContext } from "./trace.ts"

export interface NodeTelemetryContext {
  readonly correlationId: string
  readonly trace: TraceContext
  readonly feature: TelemetryFeature
  readonly workflow: TelemetryWorkflow
}

const activeTelemetry = new AsyncLocalStorage<NodeTelemetryContext>()

type WorkflowSpanEvent = Extract<HealthEvent, { readonly type: "workflow_span" }>

export interface NodeTelemetrySinkOptions {
  readonly endpoint: string
  readonly serviceName: string
  readonly deploymentEnvironment: string
  readonly releaseSha: string
  readonly fetch?: typeof fetch
  readonly now?: () => number
  readonly timeoutMs?: number
  readonly write?: (line: string) => void
}

function stringAttribute(key: string, value: string) {
  return { key, value: { stringValue: value } }
}

function intAttribute(key: string, value: number) {
  return { key, value: { intValue: String(value) } }
}

function otlpTraceEndpoint(endpoint: string): string {
  const base = endpoint.endsWith("/") ? endpoint : `${endpoint}/`
  return new URL("v1/traces", base).toString()
}

function otlpLogEndpoint(endpoint: string): string | undefined {
  try {
    const base = endpoint.endsWith("/") ? endpoint : `${endpoint}/`
    return new URL("v1/logs", base).toString()
  } catch {
    return undefined
  }
}

function otlpLogPayload(
  event: HealthEvent,
  options: Pick<
    NodeTelemetryLayerOptions,
    "serviceName" | "serviceVersion" | "deploymentEnvironment"
  >,
  observedAtMs: number
) {
  const observedTimeUnixNano = BigInt(Math.max(0, Math.round(observedAtMs))) * 1_000_000n
  return {
    resourceLogs: [
      {
        resource: {
          attributes: [
            stringAttribute("service.name", options.serviceName),
            stringAttribute("service.version", options.serviceVersion),
            stringAttribute("deployment.environment", options.deploymentEnvironment),
            stringAttribute("deployment.environment.name", options.deploymentEnvironment),
            stringAttribute("bob.release.sha", options.serviceVersion)
          ]
        },
        scopeLogs: [
          {
            scope: { name: "@bob/observability" },
            logRecords: [
              {
                timeUnixNano: observedTimeUnixNano.toString(),
                observedTimeUnixNano: observedTimeUnixNano.toString(),
                severityNumber: 9,
                severityText: "INFO",
                body: { stringValue: JSON.stringify(event) },
                attributes: [
                  stringAttribute("bob.correlation.id", event.correlationId),
                  stringAttribute("bob.event.type", event.type)
                ]
              }
            ]
          }
        ]
      }
    ]
  }
}

function nodeHealthLogWriter(options: NodeTelemetryLayerOptions): (event: HealthEvent) => void {
  const request = options.fetch ?? fetch
  const endpoint = otlpLogEndpoint(options.endpoint)
  const timeoutMs = options.exportTimeoutMs ?? 1_000
  return (input) => {
    const event = parseHealthEvent(input)
    try {
      if (options.writeHealth === undefined) console.log(JSON.stringify(event))
      else options.writeHealth(event)
    } catch {
      // Health output must not change an agent result.
    }
    if (endpoint === undefined) return
    try {
      const headers = new Headers(options.headers)
      headers.set("content-type", "application/json")
      void request(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(otlpLogPayload(event, options, Date.now())),
        signal: AbortSignal.timeout(timeoutMs)
      })
        .then((response) => response.body?.cancel())
        .catch(() => undefined)
    } catch {
      // Log export must not change an agent result.
    }
  }
}

function otlpTracePayload(
  event: WorkflowSpanEvent,
  options: Pick<NodeTelemetrySinkOptions, "serviceName" | "deploymentEnvironment" | "releaseSha">,
  endedAtMs: number
) {
  const endTimeUnixNano = BigInt(Math.max(0, Math.round(endedAtMs))) * 1_000_000n
  const durationUnixNano = BigInt(event.durationMs) * 1_000_000n
  const startTimeUnixNano =
    endTimeUnixNano >= durationUnixNano ? endTimeUnixNano - durationUnixNano : 0n
  const baseSpan = {
    traceId: event.traceId,
    spanId: event.spanId,
    name: event.name,
    kind: 1,
    startTimeUnixNano: startTimeUnixNano.toString(),
    endTimeUnixNano: endTimeUnixNano.toString(),
    attributes: [
      stringAttribute("bob.correlation_id", event.correlationId),
      stringAttribute("bob.trace_id", event.traceId),
      stringAttribute("bob.status", event.status),
      stringAttribute("bob.code", event.code),
      intAttribute("bob.duration_ms", event.durationMs),
      stringAttribute("bob.feature", event.feature),
      stringAttribute("bob.workflow", event.workflow)
    ],
    status: { code: event.status === "completed" ? 1 : 2 },
    flags: 1
  }
  const span =
    event.parentSpanId === undefined ? baseSpan : { ...baseSpan, parentSpanId: event.parentSpanId }
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            stringAttribute("service.name", options.serviceName),
            stringAttribute("service.version", options.releaseSha),
            stringAttribute("deployment.environment", options.deploymentEnvironment),
            stringAttribute("deployment.environment.name", options.deploymentEnvironment),
            stringAttribute("bob.release.sha", options.releaseSha)
          ]
        },
        scopeSpans: [
          {
            scope: { name: "@bob/observability" },
            spans: [span]
          }
        ]
      }
    ]
  }
}

export interface NodeTelemetryLayerOptions {
  readonly endpoint: string
  readonly serviceName: string
  readonly serviceVersion: string
  readonly deploymentEnvironment: string
  readonly headers?: HeadersInit
  readonly fetch?: typeof fetch
  readonly exportIntervalMs?: number
  readonly exportTimeoutMs?: number
  readonly maxQueueSize?: number
  readonly maxBatchSize?: number
  readonly writeHealth?: (event: HealthEvent) => void
}

export function nodeTelemetryLayer(options: NodeTelemetryLayerOptions): Layer.Layer<Telemetry> {
  return Layer.suspend(() => {
    const processorOptions: OtlpHttpSpanProcessorOptions = {
      endpoint: options.endpoint,
      serviceName: options.serviceName,
      serviceVersion: options.serviceVersion,
      deploymentEnvironment: options.deploymentEnvironment,
      scheduledDelayMs: options.exportIntervalMs ?? 5_000,
      flushOnShutdown: true
    }
    if (options.headers !== undefined) Object.assign(processorOptions, { headers: options.headers })
    if (options.fetch !== undefined) Object.assign(processorOptions, { fetch: options.fetch })
    if (options.exportTimeoutMs !== undefined)
      Object.assign(processorOptions, { timeoutMs: options.exportTimeoutMs })
    if (options.maxQueueSize !== undefined)
      Object.assign(processorOptions, { maxQueueSize: options.maxQueueSize })
    if (options.maxBatchSize !== undefined)
      Object.assign(processorOptions, { maxBatchSize: options.maxBatchSize })
    return telemetryLayer({
      processor: makeOtlpHttpSpanProcessor(processorOptions),
      writeHealth: nodeHealthLogWriter(options)
    })
  })
}

export function nodeEventSink(write: (line: string) => void = console.log): EventSink {
  return {
    emit(event: HealthEvent): void {
      write(JSON.stringify(parseHealthEvent(event)))
    }
  }
}

export function nodeTelemetrySink(options: NodeTelemetrySinkOptions): EventSink {
  const request = options.fetch ?? fetch
  const now = options.now ?? Date.now
  const timeoutMs = options.timeoutMs ?? 1_000
  const write = options.write ?? console.log
  const endpoint = otlpTraceEndpoint(options.endpoint)
  return {
    emit(input: HealthEvent): void {
      const event = parseHealthEvent(input)
      write(JSON.stringify(event))
      if (event.type !== "workflow_span") return
      try {
        void request(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(otlpTracePayload(event, options, now())),
          signal: AbortSignal.timeout(timeoutMs)
        }).catch(() => undefined)
      } catch {
        // Telemetry must not change an agent result.
      }
    }
  }
}

export function currentNodeTelemetryContext(): NodeTelemetryContext | undefined {
  return activeTelemetry.getStore()
}

export function runWithNodeTelemetryContext<A>(
  context: NodeTelemetryContext,
  operation: () => Promise<A>
): Promise<A> {
  return activeTelemetry.run(context, operation)
}

export async function observeNodeSpan<A>(
  input: {
    readonly sink: EventSink
    readonly name: WorkflowSpanName
    readonly feature?: TelemetryFeature
    readonly workflow?: TelemetryWorkflow
    readonly failureCode?: TelemetrySpanCode
    readonly errorCode?: (cause: unknown) => TelemetrySpanCode
    readonly resultCode?: (result: A) => TelemetrySpanCode | undefined
    readonly now?: () => number
  },
  operation: (context: TraceContext | undefined) => Promise<A>
): Promise<A> {
  const active = currentNodeTelemetryContext()
  if (active === undefined) return operation(undefined)
  const spanInput: SpanInput = {
    sink: input.sink,
    correlationId: active.correlationId,
    parent: active.trace,
    name: input.name,
    feature: input.feature ?? active.feature,
    workflow: input.workflow ?? active.workflow
  }
  if (input.failureCode !== undefined) Object.assign(spanInput, { failureCode: input.failureCode })
  if (input.errorCode !== undefined) Object.assign(spanInput, { errorCode: input.errorCode })
  if (input.now !== undefined) Object.assign(spanInput, { now: input.now })
  return observeSpan(
    spanInput,
    (trace) =>
      runWithNodeTelemetryContext(
        {
          correlationId: active.correlationId,
          trace,
          feature: input.feature ?? active.feature,
          workflow: input.workflow ?? active.workflow
        },
        () => operation(trace)
      ),
    input.resultCode
  )
}
