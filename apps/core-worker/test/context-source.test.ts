import { describe, expect, it, vi } from "vitest"

import type { ContextSourceModule } from "../src/modules/context/source.ts"

import { makeContextSourceRegistry } from "../src/modules/context/source.ts"
import { makeContextStore } from "../src/modules/context/store.ts"
import { makeRetrievalContextSource } from "../src/modules/retrieval/context-source.ts"

const request = {
  ownerId: "owner",
  channelId: "channel",
  currentMessageId: "message",
  currentUserText: "question",
  localTime: "2026-08-15T10:00:00.000Z",
  timeZone: "UTC"
}

function source(id: string, sourceId = id): ContextSourceModule {
  return {
    id,
    async load() {
      return [
        {
          disclosure: "model_and_channel",
          item: {
            kind: "record",
            text: id,
            instruction: false,
            conflict: false,
            sources: [{ sourceId, sourceLabel: id }]
          }
        }
      ]
    }
  }
}

describe("Context source Modules", () => {
  it("preserves reviewed profile order and freezes the registry", () => {
    const registry = makeContextSourceRegistry("core", [source("first"), source("second")])
    expect(registry.modules.map(({ id }) => id)).toEqual(["first", "second"])
    expect(Object.isFrozen(registry)).toBe(true)
    expect(Object.isFrozen(registry.modules)).toBe(true)
  })

  it("rejects duplicate and unknown source references", () => {
    expect(() => makeContextSourceRegistry("core", [source("same"), source("same")])).toThrow(
      "Duplicate Context source"
    )
    expect(() =>
      makeContextSourceRegistry("core", [{ ...source("later"), deduplicateAgainst: ["missing"] }])
    ).toThrow("unknown source")
  })

  it("assembles approved candidates in order and lets earlier sources win", async () => {
    const load = vi.fn(source("first", "shared").load)
    const registry = makeContextSourceRegistry("core", [
      { ...source("first", "shared"), load },
      { ...source("second", "shared"), deduplicateAgainst: ["first"] },
      source("third")
    ])
    const context = makeContextStore(registry, { load: async () => [] })
    await expect(context.build(request)).resolves.toMatchObject([
      { text: "first" },
      { text: "third" }
    ])
    expect(load).toHaveBeenCalledWith(request)
  })

  it("fails the complete build when one source fails", async () => {
    const registry = makeContextSourceRegistry("core", [
      { id: "failed", load: async () => Promise.reject(new Error("source failed")) }
    ])
    const context = makeContextStore(registry, { load: async () => [] })
    await expect(context.build(request)).rejects.toThrow("source failed")
  })

  it("applies whole-item and total budgets without slicing source data", async () => {
    const registry = makeContextSourceRegistry("core", [
      source("oversized"),
      source("1234"),
      source("ab")
    ])
    const context = makeContextStore(
      registry,
      { load: async () => [] },
      {
        itemCharacterBudget: 4,
        totalCharacterBudget: 6
      }
    )
    await expect(context.build(request)).resolves.toMatchObject([{ text: "1234" }, { text: "ab" }])
  })

  it("composes a core-only source profile without optional Modules", async () => {
    const registry = makeContextSourceRegistry("core", [source("facts"), source("records")])
    const context = makeContextStore(registry, { load: async () => [] })
    await expect(context.build(request)).resolves.toHaveLength(2)
  })

  it("keeps one unresolved retrieval conflict atomic in Context", async () => {
    const retrieval = makeRetrievalContextSource({
      retrieve: async () => ({
        status: "supported",
        candidateCount: 2,
        relevantCount: 2,
        temporal: { mode: "current", at: request.localTime },
        items: [
          {
            id: "a",
            sourceId: "source-a",
            sourceType: "record",
            memoryClass: "owner_fact",
            text: "Desk is upstairs.",
            sourceLabel: "Owner correction A",
            conflictKey: "desk",
            conflict: true
          },
          {
            id: "b",
            sourceId: "source-b",
            sourceType: "record",
            memoryClass: "owner_fact",
            text: "Desk is downstairs.",
            sourceLabel: "Owner correction B",
            conflictKey: "desk",
            conflict: true
          }
        ]
      })
    })

    await expect(retrieval.load(request)).resolves.toMatchObject([
      {
        item: {
          text: "Desk is upstairs.\nDesk is downstairs.",
          conflict: true,
          sources: [{ sourceId: "source-a" }, { sourceId: "source-b" }]
        }
      }
    ])
  })
})
