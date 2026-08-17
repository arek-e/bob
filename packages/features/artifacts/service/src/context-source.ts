import type { ContextSourceModule } from "@bob/context-types/source"

import { approvedContextItem } from "@bob/context-service/source"

import type { ArtifactStoreAdapter } from "./store.ts"

export function makeArtifactContextSource(artifacts: ArtifactStoreAdapter): ContextSourceModule {
  return {
    id: "artifact",
    async load(input) {
      const latest = await artifacts.latest(input.ownerId, input.channelId)
      if (latest === undefined) return []
      return [
        approvedContextItem({
          kind: "artifact",
          text: `Current plan:\n${latest.renderedText}`,
          instruction: false,
          conflict: false,
          sources: [
            {
              sourceId: `${latest.id}:revision:${latest.revision}`,
              sourceLabel: `plan revision ${latest.revision}`
            }
          ]
        })
      ]
    }
  }
}
