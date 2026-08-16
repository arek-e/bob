import type { ContextSourceModule } from "../context/source.ts"
import type { ArtifactStore } from "./store.ts"

import { approvedContextItem } from "../context/source.ts"

export function makeArtifactContextSource(artifacts: ArtifactStore): ContextSourceModule {
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
