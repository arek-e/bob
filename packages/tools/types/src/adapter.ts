import { Effect, Schema } from "effect"

import type {
  CapabilityCatalogue,
  CapabilityId,
  ToolCommand,
  ToolName,
  ToolResult
} from "./tools.ts"

export interface ToolCommandAdapterContext {
  readonly command: ToolCommand
  readonly run: ToolRunContext
}

export interface ToolRunContext {
  readonly correlationId: string
  readonly userText: string
  readonly localTime: string
  readonly timeZone: string
  readonly locale?: string
  readonly conversationTurnId?: string
  readonly conversationTurnRevision?: number
  readonly channelId: string
  readonly messageId: string
}

export class ToolAdapterError extends Schema.TaggedError<ToolAdapterError>()("ToolAdapterError", {
  capabilityId: Schema.String,
  operation: Schema.String,
  cause: Schema.Unknown
}) {}

export interface ToolCommandAdapter {
  readonly capabilityId: CapabilityId
  readonly names: readonly ToolName[]
  execute(context: ToolCommandAdapterContext): Effect.Effect<ToolResult, ToolAdapterError>
}

export interface ToolAdapterRegistry {
  readonly catalogue: CapabilityCatalogue
  adapterFor(name: ToolName): ToolCommandAdapter | undefined
}
