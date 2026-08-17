import type { ContextItem } from "./item.ts"

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

export type ContextSourceId = string

export interface ContextCandidate {
  readonly item: ContextItem
  readonly disclosure: "model_and_channel"
}

export interface ContextSourceModule {
  readonly id: ContextSourceId
  readonly deduplicateAgainst?: readonly ContextSourceId[]
  load(input: ContextBuildRequest): Promise<readonly ContextCandidate[]>
}

export interface ContextSourceRegistry {
  readonly profileId: string
  readonly modules: readonly ContextSourceModule[]
}
