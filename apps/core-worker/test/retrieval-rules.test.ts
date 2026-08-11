import { describe, expect, it } from "vitest"

import { buildFtsQuery, rankRetrievalCandidates } from "../src/modules/memory/retrieval.ts"

describe("memory retrieval rules", () => {
  it("quotes untrusted FTS input and applies a token limit", () => {
    expect(buildFtsQuery('routine" OR secret* -- routine')).toBe('"routine" OR "or" OR "secret"')
    expect(buildFtsQuery("a I !")).toBeUndefined()
    expect(buildFtsQuery(Array.from({ length: 20 }, (_, index) => `term${index}`).join(" "))).toBe(
      '"term0" OR "term1" OR "term2" OR "term3" OR "term4" OR "term5" OR "term6" OR "term7" OR "term8" OR "term9" OR "term10" OR "term11"'
    )
  })

  it("keeps stable facts evergreen and limits one source type", () => {
    const ranked = rankRetrievalCandidates(
      [
        {
          id: "old-fact",
          sourceId: "fact-revision-old",
          sourceType: "fact_revision",
          text: "Stable fact",
          sourceLabel: "fact 2020-01-01",
          occurredAt: "2020-01-01T00:00:00.000Z",
          importance: 1_000,
          lexicalPosition: 1
        },
        ...Array.from({ length: 5 }, (_, index) => ({
          id: `journal-${index}`,
          sourceId: `journal-entry-${index}`,
          sourceType: "journal_summary",
          text: `Journal ${index}`,
          sourceLabel: `journal ${index}`,
          occurredAt: "2026-08-10T00:00:00.000Z",
          importance: 500,
          lexicalPosition: index
        }))
      ],
      {
        nowMs: Date.parse("2026-08-11T00:00:00.000Z"),
        limit: 4,
        perSourceType: 2
      }
    )

    expect(ranked.some((candidate) => candidate.id === "old-fact")).toBe(true)
    expect(ranked.filter((candidate) => candidate.sourceType === "journal_summary")).toHaveLength(2)
  })
})
