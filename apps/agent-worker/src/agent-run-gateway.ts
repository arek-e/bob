import type {
  AgentRunAttemptAuthority,
  AgentRunGatewayService,
  AppendAgentRunCheckpoint,
  RecordAgentRunOutcome,
  RenewAgentRunLease
} from "@bob/agent-runs-types/worker-gateway"

import {
  AcquireAgentRunResult,
  AgentRunAttemptAuthority as AgentRunAttemptAuthoritySchema,
  AgentRunAuthorityLost,
  AgentRunCheckpointConflict,
  AgentRunControl,
  AgentRunGatewayUnavailable
} from "@bob/agent-runs-types/worker-gateway"
import { Effect, Schema } from "effect"

export function createCoreAgentRunGateway(options: {
  readonly coreUrl: string
  readonly callerSecret: string
}): AgentRunGatewayService {
  async function post<Body, A>(
    path: string,
    body: Body,
    decode: (input: typeof Schema.Json.Type) => A,
    authority?: AgentRunAttemptAuthority
  ): Promise<A> {
    const response = await fetch(`${options.coreUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-bob-caller-token": options.callerSecret
      },
      body: JSON.stringify(body)
    })
    if (response.status === 409 && authority !== undefined) {
      throw new AgentRunAuthorityLost({
        runId: authority.runId,
        attemptId: authority.attemptId
      })
    }
    if (!response.ok) {
      throw new AgentRunGatewayUnavailable({
        operation: path,
        cause: new Error(`Core Agent Run Gateway returned ${response.status}`)
      })
    }
    return decode(Schema.decodeUnknownSync(Schema.Json)(await response.json()))
  }

  const gatewayFailure = (operation: string, cause: unknown) =>
    cause instanceof AgentRunAuthorityLost || cause instanceof AgentRunGatewayUnavailable
      ? cause
      : new AgentRunGatewayUnavailable({ operation, cause })

  return {
    acquire: (input) =>
      Effect.tryPromise({
        try: () =>
          post(
            "/internal/agent-runs/acquire",
            input,
            Schema.decodeUnknownSync(AcquireAgentRunResult)
          ),
        catch: (cause) =>
          cause instanceof AgentRunGatewayUnavailable
            ? cause
            : new AgentRunGatewayUnavailable({ operation: "acquire", cause })
      }),
    renew: (input: RenewAgentRunLease) =>
      Effect.tryPromise({
        try: () =>
          post(
            "/internal/agent-runs/renew",
            input,
            Schema.decodeUnknownSync(AgentRunAttemptAuthoritySchema),
            input.authority
          ),
        catch: (cause) => gatewayFailure("renew", cause)
      }),
    appendCheckpoint: (input: AppendAgentRunCheckpoint) =>
      Effect.tryPromise({
        try: async () => {
          const result = await post<
            AppendAgentRunCheckpoint,
            { readonly status: "appended" | "duplicate" }
          >(
            "/internal/agent-runs/checkpoint",
            input,
            Schema.decodeUnknownSync(
              Schema.Struct({ status: Schema.Literals(["appended", "duplicate"]) })
            ),
            input.authority
          )
          return result.status
        },
        catch: (cause) =>
          cause instanceof AgentRunCheckpointConflict
            ? cause
            : gatewayFailure("appendCheckpoint", cause)
      }),
    readControl: (authority) =>
      Effect.tryPromise({
        try: () =>
          post(
            "/internal/agent-runs/control",
            authority,
            Schema.decodeUnknownSync(AgentRunControl),
            authority
          ),
        catch: (cause) => gatewayFailure("readControl", cause)
      }),
    recordOutcome: (input: RecordAgentRunOutcome) =>
      Effect.tryPromise({
        try: async () => {
          const result = await post<
            RecordAgentRunOutcome,
            { readonly status: "accepted" | "duplicate" }
          >(
            "/internal/agent-runs/outcome",
            input,
            Schema.decodeUnknownSync(
              Schema.Struct({ status: Schema.Literals(["accepted", "duplicate"]) })
            ),
            input.authority
          )
          return result.status
        },
        catch: (cause) => gatewayFailure("recordOutcome", cause)
      })
  }
}
