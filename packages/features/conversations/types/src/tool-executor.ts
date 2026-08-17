import type { EffectAdapter } from "@bob/capabilities-types/effect-adapter"
import type { ToolResult } from "@bob/capabilities-types/tools"

import { Context, Schema } from "effect"

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

export interface ToolExecutorAdapter {
  execute<Input>(input: Input): Promise<ToolResult>
  mutationActivity(runId: string): Promise<MutationActivity>
  expireMutationRecovery(runId: string): Promise<boolean>
}

export class ToolExecutorError extends Schema.TaggedError<ToolExecutorError>()(
  "ToolExecutorError",
  { operation: Schema.String, cause: Schema.Unknown }
) {}

export class ToolExecutor extends Context.Service<
  ToolExecutor,
  EffectAdapter<ToolExecutorAdapter, ToolExecutorError>
>()("@bob/conversations/ToolExecutor") {}
