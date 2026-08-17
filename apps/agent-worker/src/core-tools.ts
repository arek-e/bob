import {
  AgentRunOperationAppendResult,
  AgentRunOperationsLoadResult,
  type AgentRunOperation
} from "@bob/agent-types/run"
import {
  ToolResult,
  type CapabilityCatalogue,
  type ToolCommand
} from "@bob/capabilities-types/tools"
import { currentBobCorrelationId, Telemetry, injectCurrentTraceparent } from "@bob/observability"
import { Context, Effect, Exit, Layer, Option, Schema } from "effect"

export class CoreToolClientError extends Schema.TaggedError<CoreToolClientError>()(
  "CoreToolClientError",
  {
    operation: Schema.Literals(["execute", "load_operations", "append_operation", "readiness"]),
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Unknown)
  }
) {}

export interface CoreToolClient {
  readonly execute: (
    command: ToolCommand
  ) => Effect.Effect<typeof ToolResult.Type, CoreToolClientError>
  readonly loadRunOperations: (
    runId: string,
    attemptId: string
  ) => Effect.Effect<readonly AgentRunOperation[], CoreToolClientError>
  readonly appendRunOperation: (
    operation: AgentRunOperation,
    attemptId: string
  ) => Effect.Effect<void, CoreToolClientError>
  readonly checkReadiness: () => Effect.Effect<boolean, CoreToolClientError>
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

  const requestResponse = (
    operation: CoreToolClientError["operation"],
    path: string,
    init: RequestInit,
    timeoutMs: number
  ): Effect.Effect<Response, CoreToolClientError> =>
    Effect.tryPromise({
      try: (signal) => request(`${options.coreUrl}${path}`, { ...init, signal }),
      catch: (cause) =>
        new CoreToolClientError({ operation, message: "Core request failed", cause })
    }).pipe(
      Effect.timeout(timeoutMs),
      Effect.mapError((cause) =>
        cause instanceof CoreToolClientError
          ? cause
          : new CoreToolClientError({ operation, message: "Core request timed out", cause })
      )
    )

  const decodeResponse = <A, I, R>(
    operation: CoreToolClientError["operation"],
    schema: Schema.Codec<A, I, R>,
    response: Response
  ): Effect.Effect<A, CoreToolClientError, R> =>
    Effect.gen(function* () {
      if (!response.ok) {
        return yield* Effect.fail(
          new CoreToolClientError({
            operation,
            message: `Core request failed with status ${response.status}`
          })
        )
      }
      const body = yield* Effect.tryPromise({
        try: () => response.json(),
        catch: (cause) =>
          new CoreToolClientError({ operation, message: "Core response is not JSON", cause })
      })
      return yield* Schema.decodeUnknownEffect(schema)(body).pipe(
        Effect.mapError(
          (cause) =>
            new CoreToolClientError({ operation, message: "Core response is invalid", cause })
        )
      )
    })

  const execute = Effect.fnUntraced(function* (command: ToolCommand) {
    const startedAt = now()
    const activeCorrelationId = yield* currentBobCorrelationId
    const correlationId = activeCorrelationId ?? command.runId
    const execution = Effect.gen(function* () {
      const headers = yield* injectCurrentTraceparent({
        "content-type": "application/json",
        "x-bob-caller-token": options.callerSecret,
        "x-bob-correlation-id": correlationId
      })
      const response = yield* requestResponse(
        "execute",
        "/internal/tools",
        { method: "POST", headers, body: JSON.stringify(command) },
        options.catalogue.isReadOnly(command.name) ? 15_000 : 65_000
      )
      return yield* decodeResponse("execute", ToolResult, response)
    })
    return yield* execution.pipe(
      Effect.onExit((exit) =>
        Effect.flatMap(Effect.serviceOption(Telemetry), (telemetry) =>
          Option.isNone(telemetry)
            ? Effect.void
            : telemetry.value.emitHealth({
                type: "tool_call",
                correlationId,
                runId: command.runId,
                toolName: command.name,
                status: Exit.isSuccess(exit) && exit.value.ok ? "completed" : "failed",
                durationMs: Math.max(0, Math.round(now() - startedAt))
              })
        ).pipe(Effect.catchCause(() => Effect.void))
      )
    )
  })

  return {
    execute,
    loadRunOperations: Effect.fnUntraced(function* (runId, attemptId) {
      const response = yield* requestResponse(
        "load_operations",
        "/internal/agent/operations/load",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-bob-caller-token": options.callerSecret
          },
          body: JSON.stringify({ runId, attemptId })
        },
        15_000
      )
      const result = yield* decodeResponse(
        "load_operations",
        AgentRunOperationsLoadResult,
        response
      )
      return result.operations
    }),
    appendRunOperation: Effect.fnUntraced(function* (operation, attemptId) {
      const response = yield* requestResponse(
        "append_operation",
        "/internal/agent/operations",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-bob-caller-token": options.callerSecret
          },
          body: JSON.stringify({ operation, attemptId })
        },
        15_000
      )
      yield* decodeResponse("append_operation", AgentRunOperationAppendResult, response)
    }),
    checkReadiness: () =>
      requestResponse(
        "readiness",
        "/internal/readiness",
        { headers: { "x-bob-caller-token": options.callerSecret } },
        5_000
      ).pipe(Effect.map((response) => response.ok))
  }
}

export function coreToolClientLayer(service: CoreToolClient): Layer.Layer<CoreToolClient> {
  return Layer.succeed(CoreToolClient, service)
}
