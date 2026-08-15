import type { ContextItem } from "@bob/contracts/agent"

import { describe, expect, it, vi } from "vitest"

import { contextSourceOrder, defineContextSourceModules } from "../src/modules/context/source.ts"

const emptySource = vi.fn(async (): Promise<readonly ContextItem[]> => [])

describe("Context source Modules", () => {
  it("keeps the complete reviewed source precedence", () => {
    expect(contextSourceOrder).toEqual([
      "inline_reply",
      "profile",
      "conversation",
      "artifact",
      "lexical",
      "tool_receipts"
    ])
  })

  it("builds one ordered Module for every reviewed source", () => {
    const modules = defineContextSourceModules({
      inline_reply: emptySource,
      profile: emptySource,
      conversation: emptySource,
      artifact: emptySource,
      lexical: emptySource,
      tool_receipts: emptySource
    })

    expect(modules.map(({ id, order }) => ({ id, order }))).toEqual(
      contextSourceOrder.map((id, order) => ({ id, order }))
    )
    expect(Object.isFrozen(modules)).toBe(true)
    expect(modules.every(Object.isFrozen)).toBe(true)
  })
})
