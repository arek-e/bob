import { ToolResult, type CapabilityCatalogue, type ToolCommand } from "@bob/contracts/tools"
import { currentBobCorrelationId, Telemetry } from "@bob/observability/effect"
import { injectCurrentTraceparent } from "@bob/observability/propagation"
import { Context, Effect, Layer, Option, Schema } from "effect"

export interface CoreToolClient {
  executeEffect(
    command: ToolCommand,
    signal?: AbortSignal
  ): Effect.Effect<typeof ToolResult.Type, unknown>
  execute(command: ToolCommand, signal?: AbortSignal): Promise<typeof ToolResult.Type>
  checkReadiness(signal?: AbortSignal): Promise<boolean>
}

export const CoreToolClient = Context.Service<CoreToolClient>("bob/CoreToolClient")

export function createCoreToolClient(options: {
  readonly catalogue: CapabilityCatalogue
  readonly coreUrl: string
  readonly accessClientId: string
  readonly accessClientSecret: string
  readonly fetch?: typeof fetch
  readonly now?: () => number
}): CoreToolClient {
  const request = options.fetch ?? fetch
  const now = options.now ?? Date.now
  const executeEffect = (
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
            "CF-Access-Client-Id": options.accessClientId,
            "CF-Access-Client-Secret": options.accessClientSecret,
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
    executeEffect,
    execute: (command, signal) => Effect.runPromise(executeEffect(command, signal)),
    async checkReadiness(signal) {
      const requestSignal =
        signal === undefined
          ? AbortSignal.timeout(5_000)
          : AbortSignal.any([signal, AbortSignal.timeout(5_000)])
      const response = await request(`${options.coreUrl}/internal/readiness`, {
        headers: {
          "CF-Access-Client-Id": options.accessClientId,
          "CF-Access-Client-Secret": options.accessClientSecret
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
