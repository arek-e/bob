import type { ContextSourceModule } from "../context/source.ts"
import type { RetrievalPipeline } from "./pipeline.ts"

import { approvedContextItem } from "../context/source.ts"

export function makeRetrievalContextSource(
  retrieval: RetrievalPipeline,
  options: {
    readonly characterBudget?: number
    readonly itemCharacterBudget?: number
    readonly limit?: number
  } = {}
): ContextSourceModule {
  return {
    id: "retrieval",
    deduplicateAgainst: ["inline_reply", "conversation", "artifact"],
    async load(input) {
      const result = await retrieval.retrieve({
        ownerId: input.ownerId,
        query: input.currentUserText,
        channel: true,
        referenceTime: input.localTime,
        timeZone: input.timeZone,
        limit: options.limit ?? 8,
        totalCharacterBudget: options.characterBudget ?? 2_400,
        itemCharacterBudget: options.itemCharacterBudget ?? 1_200
      })
      if (result.status === "abstain") return []
      const groups = new Map<string, typeof result.items>()
      for (const item of result.items) {
        const key = item.conflict ? (item.conflictKey ?? item.id) : item.id
        groups.set(key, Object.freeze([...(groups.get(key) ?? []), item]))
      }
      return [...groups.values()].map((items) => {
        const first = items[0]
        if (first === undefined) throw new Error("Retrieval returned an empty record group")
        return approvedContextItem({
          kind: "record",
          text: items.map((item) => item.text).join("\n"),
          instruction: false,
          conflict: first.conflict,
          sources: items.map((item) =>
            item.occurredAt === undefined
              ? { sourceId: item.sourceId, sourceLabel: item.sourceLabel }
              : {
                  sourceId: item.sourceId,
                  sourceLabel: item.sourceLabel,
                  occurredAt: item.occurredAt
                }
          )
        })
      })
    }
  }
}
