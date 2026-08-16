import type { ContextItem, PriorToolReceipt } from "@bob/contracts/agent"

import { Context, Layer, Schema } from "effect"

import {
  boundContextItems,
  type ContextBuildRequest,
  type ContextSourceRegistry
} from "./source.ts"

export type { ContextBuildRequest } from "./source.ts"
export { boundContextItems } from "./source.ts"

export interface PriorToolReceiptSource {
  load(input: ContextBuildRequest): Promise<readonly PriorToolReceipt[]>
}

export interface ContextStore {
  build(input: ContextBuildRequest | string, channelId?: string): Promise<readonly ContextItem[]>
  priorToolReceipts(input: ContextBuildRequest): Promise<readonly PriorToolReceipt[]>
}

export const ContextStore = Context.Service<ContextStore>("bob/ContextStore")

export function makeContextStore(
  registry: ContextSourceRegistry,
  receipts: PriorToolReceiptSource,
  options: {
    readonly totalCharacterBudget?: number
    readonly itemCharacterBudget?: number
  } = {}
): ContextStore {
  const totalCharacterBudget = options.totalCharacterBudget ?? 6_000
  const itemCharacterBudget = options.itemCharacterBudget ?? 1_200

  return {
    priorToolReceipts: (input) => receipts.load(input),
    async build(inputOrOwnerId, legacyChannelId) {
      const input: ContextBuildRequest = Schema.is(Schema.String)(inputOrOwnerId)
        ? {
            ownerId: inputOrOwnerId,
            channelId: legacyChannelId ?? "",
            currentMessageId: "legacy-storage-test",
            currentUserText: "",
            localTime: new Date(0).toISOString(),
            timeZone: "UTC"
          }
        : inputOrOwnerId
      const selectedByModule = new Map<string, readonly ContextItem[]>()
      const output: ContextItem[] = []
      for (const source of registry.modules) {
        const candidates = await source.load(input)
        const priorIds = new Set(
          (source.deduplicateAgainst ?? []).flatMap((id) =>
            (selectedByModule.get(id) ?? []).flatMap((item) =>
              item.sources.map((itemSource) => itemSource.sourceId)
            )
          )
        )
        const selected = candidates
          .filter((candidate) => candidate.disclosure === "model_and_channel")
          .map((candidate) => candidate.item)
          .filter((item) => item.sources.every((itemSource) => !priorIds.has(itemSource.sourceId)))
        selectedByModule.set(source.id, Object.freeze(selected))
        output.push(...selected)
      }
      return boundContextItems(output, totalCharacterBudget, itemCharacterBudget)
    }
  }
}

export function contextStoreLayer(store: ContextStore) {
  return Layer.succeed(ContextStore, store)
}
