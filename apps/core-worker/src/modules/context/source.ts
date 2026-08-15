import type { ContextItem } from "@bob/contracts/agent"

export interface ContextBuildRequest {
  readonly ownerId: string
  readonly channelId: string
  readonly currentMessageId: string
  readonly currentConversationTurnId?: string
  readonly currentConversationTurnRevision?: number
  readonly currentUserText: string
  readonly localTime: string
  readonly timeZone: string
}

/** Reviewed source precedence for every immutable Context pack. */
export const contextSourceOrder = Object.freeze([
  "inline_reply",
  "profile",
  "conversation",
  "artifact",
  "lexical",
  "tool_receipts"
] as const)

export type ContextSourceId = (typeof contextSourceOrder)[number]

export interface ContextSourceModule {
  readonly id: ContextSourceId
  readonly order: number
  load(input: ContextBuildRequest, key: CryptoKey): Promise<readonly ContextItem[]>
}

type ContextSourceLoader = ContextSourceModule["load"]
type ContextSourceLoaders = Readonly<Record<ContextSourceId, ContextSourceLoader>>

/** Build the complete static source list. Callers cannot omit or add a source. */
export function defineContextSourceModules(
  loaders: ContextSourceLoaders
): readonly ContextSourceModule[] {
  return Object.freeze(
    contextSourceOrder.map((id, order) => Object.freeze({ id, order, load: loaders[id] }))
  )
}
