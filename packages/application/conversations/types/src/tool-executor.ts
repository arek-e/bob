import type { ToolCommand, ToolResult } from "@bob/tools-types/tools"

import { Context, Effect, Schema } from "effect"

export type MutationActivity =
  | { readonly status: "none" }
  | { readonly status: "unknown" }
  | {
      readonly status: "completed"
      readonly completedInRun: boolean
    }
  | {
      readonly status: "active"
      readonly retryAt: string
      readonly recoveryRequired: boolean
      readonly recoveryExhausted: boolean
      readonly originRevision?: number
    }

export class ToolExecutorError extends Schema.TaggedError<ToolExecutorError>()(
  "ToolExecutorError",
  { operation: Schema.String, cause: Schema.Unknown }
) {}

export interface ToolExecutorService {
  execute(input: ToolCommand): Effect.Effect<ToolResult, ToolExecutorError>
  mutationActivity(runId: string): Effect.Effect<MutationActivity, ToolExecutorError>
  expireMutationRecovery(runId: string): Effect.Effect<boolean, ToolExecutorError>
}

export class ToolExecutor extends Context.Service<ToolExecutor, ToolExecutorService>()(
  "@bob/conversations/ToolExecutor"
) {}
