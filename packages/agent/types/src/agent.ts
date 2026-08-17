import type { ToolCommand, ToolResult } from "@bob/tools-types/tools"

import { Context, Effect, Schema } from "effect"

import type {
  AgentRunOperation,
  AgentRunRequest,
  AgentRunResult,
  AgentSmokeResult,
  AgentSteerResult,
  DeviceLoginEvent
} from "./run.ts"

export const AgentModelConfiguration = Schema.Struct({
  provider: Schema.NonEmptyString,
  model: Schema.NonEmptyString,
  allowedModels: Schema.Array(Schema.NonEmptyString).check(Schema.isNonEmpty())
})

export type AgentModelConfiguration = typeof AgentModelConfiguration.Type

export const AuthStatus = Schema.Struct({
  configured: Schema.Boolean,
  provider: Schema.NonEmptyString,
  accountIdRedacted: Schema.optionalKey(Schema.String),
  expiresAt: Schema.optionalKey(Schema.String)
})

export type AuthStatus = typeof AuthStatus.Type

export class AgentConfigurationError extends Schema.TaggedError<AgentConfigurationError>()(
  "AgentConfigurationError",
  {
    message: Schema.String
  }
) {}

export class AgentCheckpointError extends Schema.TaggedError<AgentCheckpointError>()(
  "AgentCheckpointError",
  {
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Unknown)
  }
) {}

export class AgentProviderError extends Schema.TaggedError<AgentProviderError>()(
  "AgentProviderError",
  {
    code: Schema.Literals(["authentication", "quota", "timeout", "cancelled", "provider"]),
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Unknown)
  }
) {}

export class AgentToolError extends Schema.TaggedError<AgentToolError>()("AgentToolError", {
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Unknown)
}) {}

export type AgentError =
  | AgentCheckpointError
  | AgentConfigurationError
  | AgentProviderError
  | AgentToolError

export interface AgentRunDurability {
  readonly operations: readonly AgentRunOperation[]
  readonly append: (operation: AgentRunOperation) => Effect.Effect<void, AgentCheckpointError>
}

export interface BobAgentShape {
  readonly runTurn: (
    request: AgentRunRequest,
    durability?: AgentRunDurability
  ) => Effect.Effect<AgentRunResult, AgentCheckpointError>
  readonly runSmoke: () => Effect.Effect<AgentSmokeResult>
  readonly requestSteer: (runId: AgentRunRequest["runId"]) => Effect.Effect<AgentSteerResult>
  readonly getAuthStatus: () => Effect.Effect<AuthStatus, AgentProviderError>
  readonly startDeviceLogin: () => Effect.Effect<DeviceLoginEvent>
}

export class BobAgent extends Context.Service<BobAgent, BobAgentShape>()("@bob/agent/BobAgent") {}

export type ExecuteTool = (command: ToolCommand) => Effect.Effect<ToolResult, AgentToolError>
