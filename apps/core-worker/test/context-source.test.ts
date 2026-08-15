import { describe, expect, it, vi } from "vitest"

import type { ContextSourceModule } from "../src/modules/context/source.ts"

import { makeContextSourceRegistry } from "../src/modules/context/source.ts"
import { makeContextStore } from "../src/modules/context/store.ts"

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

  it("applies the common item and total budgets", async () => {
    const registry = makeContextSourceRegistry("core", [source("123456"), source("abcdef")])
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
})
