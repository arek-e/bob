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

export function makeContextSourceRegistry(
  profileId: string,
  modules: readonly ContextSourceModule[]
): ContextSourceRegistry {
  if (profileId.trim().length === 0) throw new Error("Context profile ID is required")
  const ids = new Set<string>()
  for (const module of modules) {
    if (module.id.trim().length === 0) throw new Error("Context source ID is required")
    if (ids.has(module.id)) throw new Error(`Duplicate Context source ${module.id}`)
    ids.add(module.id)
  }
  for (const module of modules) {
    for (const dependency of module.deduplicateAgainst ?? []) {
      if (!ids.has(dependency)) {
        throw new Error(`Context source ${module.id} references unknown source ${dependency}`)
      }
    }
  }
  return Object.freeze({ profileId, modules: Object.freeze([...modules]) })
}

export function approvedContextItem(item: ContextItem): ContextCandidate {
  return Object.freeze({ item, disclosure: "model_and_channel" })
}

export function boundContextItems(
  items: readonly ContextItem[],
  totalCharacterBudget: number,
  itemCharacterBudget: number
): readonly ContextItem[] {
  const bounded: ContextItem[] = []
  let remaining = totalCharacterBudget
  for (const item of items) {
    if (remaining <= 0) break
    if (item.text.length > itemCharacterBudget || item.text.length > remaining) continue
    bounded.push(item)
    remaining -= item.text.length
  }
  return Object.freeze(bounded)
}
