import {
  AgentRunOperationAppendResult,
  AgentRunOperationsLoadResult,
  type AgentRunOperation
} from "@bob/contracts/agent"
import { ToolResult, type CapabilityCatalogue, type ToolCommand } from "@bob/contracts/tools"
import { currentBobCorrelationId, Telemetry } from "@bob/observability/effect"
import { injectCurrentTraceparent } from "@bob/observability/propagation"
import { Context, Effect, Layer, Option, Schema } from "effect"

export interface CoreToolClient {
  execute(
    command: ToolCommand,
    signal?: AbortSignal
  ): Effect.Effect<typeof ToolResult.Type, unknown>
  loadRunOperations(runId: string, attemptId: string): Promise<readonly AgentRunOperation[]>
  appendRunOperation(operation: AgentRunOperation, attemptId: string): Promise<void>
  checkReadiness(signal?: AbortSignal): Promise<boolean>
}

export const CoreToolClient = Context.Service<CoreToolClient>("bob/CoreToolClient")

export function createCoreToolClient(options: {
  readonly catalogue: CapabilityCatalogue
  readonly coreUrl: string
  readonly callerSecret: string
  readonly fetch?: typeof fetch
  readonly now?: () => number
}): CoreToolClient {
  const request = options.fetch ?? fetch
  const now = options.now ?? Date.now
  const execute = (
    command: ToolCommand,
    signal?: AbortSignal
  ): Effect.Effect<typeof ToolResult.Type, unknown> =>
    Effect.suspend(() => {
      const startedAt = now()
      let status: "completed" | "failed" = "failed"
      return Effect.flatMap(currentBobCorrelationId, (activeCorrelationId) => {
        const correlationId = activeCorrelationId ?? command.runId
        const execution = Effect.gen(function* () {
          const headers = yield* injectCurrentTraceparent({
            "content-type": "application/json",
            "x-bob-caller-token": options.callerSecret,
            "x-bob-correlation-id": correlationId
          })
          const result = yield* Effect.tryPromise({
            try: async () => {
              const requestSignal = options.catalogue.isReadOnly(command.name)
                ? signal === undefined
                  ? AbortSignal.timeout(15_000)
                  : AbortSignal.any([signal, AbortSignal.timeout(15_000)])
                : (signal ?? AbortSignal.timeout(65_000))
              const response = await request(`${options.coreUrl}/internal/tools`, {
                method: "POST",
                headers,
                body: JSON.stringify(command),
                signal: requestSignal
              })
              if (!response.ok) throw new Error(`Core tool request failed: ${response.status}`)
              return Schema.decodeUnknownSync(ToolResult)(await response.json())
            },
            catch: (error) => error
          })
          status = result.ok ? "completed" : "failed"
          return result
        })
        const emitResult = Effect.flatMap(Effect.serviceOption(Telemetry), (telemetry) =>
          Option.isNone(telemetry)
            ? Effect.void
            : telemetry.value.emitHealth({
                type: "tool_call",
                correlationId,
                runId: command.runId,
                toolName: command.name,
                status,
                durationMs: Math.max(0, Math.round(now() - startedAt))
              })
        ).pipe(Effect.catchCause(() => Effect.void))
        return execution.pipe(Effect.ensuring(emitResult))
      })
    })

  return {
    execute,
    async loadRunOperations(runId, attemptId) {
      const response = await request(`${options.coreUrl}/internal/agent/operations/load`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-bob-caller-token": options.callerSecret
        },
        body: JSON.stringify({ runId, attemptId }),
        signal: AbortSignal.timeout(15_000)
      })
      if (!response.ok) throw new Error(`Core operation load failed: ${response.status}`)
      return Schema.decodeUnknownSync(AgentRunOperationsLoadResult)(await response.json())
        .operations
    },
    async appendRunOperation(operation, attemptId) {
      const response = await request(`${options.coreUrl}/internal/agent/operations`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-bob-caller-token": options.callerSecret
        },
        body: JSON.stringify({ operation, attemptId }),
        signal: AbortSignal.timeout(15_000)
      })
      if (!response.ok) throw new Error(`Core operation append failed: ${response.status}`)
      Schema.decodeUnknownSync(AgentRunOperationAppendResult)(await response.json())
    },
    async checkReadiness(signal) {
      const requestSignal =
        signal === undefined
          ? AbortSignal.timeout(5_000)
          : AbortSignal.any([signal, AbortSignal.timeout(5_000)])
      const response = await request(`${options.coreUrl}/internal/readiness`, {
        headers: {
          "x-bob-caller-token": options.callerSecret
        },
        signal: requestSignal
      })
      return response.ok
    }
  }
}

export function coreToolClientLayer(service: CoreToolClient) {
  return Layer.succeed(CoreToolClient, service)
}
