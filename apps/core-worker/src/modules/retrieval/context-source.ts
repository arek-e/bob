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
      return result.items.map((unit) => {
        const items = unit.kind === "conflict_group" ? unit.items : [unit.item]
        return approvedContextItem({
          kind: "record",
          text: items.map((item) => item.text).join("\n"),
          instruction: false,
          conflict: unit.kind === "conflict_group",
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
