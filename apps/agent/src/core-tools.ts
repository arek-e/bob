import type { EventSink } from "@bob/observability/events"

import { ToolResult, type ToolCommand } from "@bob/contracts/tools"
import { featureForToolName } from "@bob/observability/attribution"
import { currentNodeTelemetryContext, observeNodeSpan } from "@bob/observability/node"
import { traceHeaders } from "@bob/observability/trace"
import { Context, Layer, Schema } from "effect"

export interface CoreToolClient {
  execute(command: ToolCommand, signal?: AbortSignal): Promise<typeof ToolResult.Type>
}

export const CoreToolClient = Context.Service<CoreToolClient>("bob/CoreToolClient")

export function createCoreToolClient(options: {
  readonly coreUrl: string
  readonly accessClientId: string
  readonly accessClientSecret: string
  readonly fetch?: typeof fetch
  readonly events?: EventSink
  readonly now?: () => number
}): CoreToolClient {
  const request = options.fetch ?? fetch
  const now = options.now ?? Date.now
  return {
    async execute(command, signal) {
      const startedAt = now()
      const feature = featureForToolName(command.name)
      let status: "completed" | "failed" = "failed"
      try {
        const execute = async (trace: Parameters<typeof traceHeaders>[0] | undefined) => {
          const active = currentNodeTelemetryContext()
          const response = await request(`${options.coreUrl}/internal/tools`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "CF-Access-Client-Id": options.accessClientId,
              "CF-Access-Client-Secret": options.accessClientSecret,
              ...(trace === undefined ? {} : traceHeaders(trace)),
              ...(active === undefined ? {} : { "x-bob-correlation-id": active.correlationId })
            },
            body: JSON.stringify(command),
            signal:
              signal === undefined
                ? AbortSignal.timeout(15_000)
                : AbortSignal.any([signal, AbortSignal.timeout(15_000)])
          })
          if (!response.ok) throw new Error(`Core tool request failed: ${response.status}`)
          const result = Schema.decodeUnknownSync(ToolResult)(await response.json())
          status = result.ok ? "completed" : "failed"
          return result
        }
        return options.events === undefined
          ? await execute(undefined)
          : await observeNodeSpan(
              {
                sink: options.events,
                name: "tool.execute",
                feature,
                workflow: "tool_execution",
                failureCode: "core_request",
                resultCode: (result) => (result.ok ? undefined : "tool_execution"),
                now
              },
              execute
            )
      } finally {
        if (options.events !== undefined) {
          try {
            await options.events.emit({
              type: "tool_call",
              correlationId: currentNodeTelemetryContext()?.correlationId ?? command.runId,
              runId: command.runId,
              toolCallId: command.toolCallId,
              toolName: command.name,
              status,
              durationMs: Math.max(0, Math.round(now() - startedAt))
            })
          } catch {
            // Telemetry must not change a tool result.
          }
        }
      }
    }
  }
}

export function coreToolClientLayer(service: CoreToolClient) {
  return Layer.succeed(CoreToolClient, service)
}
