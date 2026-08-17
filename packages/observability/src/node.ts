import { Layer } from "effect"

import { telemetryLayer, type Telemetry } from "./effect.ts"
import { parseHealthEvent, type HealthEvent } from "./events.ts"
import { makeOtlpHttpSpanProcessor, type OtlpHttpSpanProcessorOptions } from "./otlp.ts"

function stringAttribute(key: string, value: string) {
  return { key, value: { stringValue: value } }
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
