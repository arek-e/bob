import type {
  RankedRetrievalCandidate,
  RankedRetrievalUnit,
  RetrievalCandidate
} from "@bob/core-service/retrieval/rules"

import { retrievalProjection } from "@bob/core-service/retrieval/projection"
import {
  analyzeRetrievalQuery,
  boundRetrievalReading,
  buildFtsQuery,
  selectRelevantCandidates
} from "@bob/core-service/retrieval/rules"
import { describe, expect, it } from "vitest"

const referenceTime = "2026-08-11T10:00:00.000Z"
const current = { mode: "current", at: referenceTime } as const

function candidate(
  id: string,
  text: string,
  overrides: Partial<RetrievalCandidate> = {}
): RetrievalCandidate {
  return {
    id,
    sourceId: `source-${id}`,
    sourceType: "fact_revision",
    memoryClass: "owner_fact",
    text,
    sourceLabel: `source ${id}`,
    importance: 500,
    lexicalPosition: 0,
    ...overrides
  }
}

function selectedCandidates(units: readonly RankedRetrievalUnit[]) {
  return units.flatMap((unit) =>
    unit.kind === "conflict_group" ? [...unit.candidates] : [unit.candidate]
  )
}

function rankedCandidate(id: string, text: string): RankedRetrievalCandidate {
  return { ...candidate(id, text), relevance: 1 }
}

describe("Retrieval pipeline rules", () => {
  it("validates the common source projection before indexing", () => {
    const base = {
      id: "document",
      ownerId: "owner",
      sourceType: "record",
      sourceId: "source",
      memoryClass: "owner_fact" as const,
      text: "Owner value",
      sourceLabel: "Owner message",
      importance: 500,
      sensitivity: "normal",
      modelEligible: true,
      channelEligible: true,
      createdAt: referenceTime
    }
    const projection = retrievalProjection(base)
    expect(projection).toMatchObject({
      text: "Owner value",
      searchText: "Owner value"
    })
    expect(projection).not.toHaveProperty("validFrom")
    expect(() => retrievalProjection({ ...base, text: " " })).toThrow("Retrieval text is invalid")
    expect(() =>
      retrievalProjection({
        ...base,
        validFrom: "2026-08-12T00:00:00.000Z",
        validTo: "2026-08-11T00:00:00.000Z"
      })
    ).toThrow("validity interval")
  })

  it("quotes untrusted FTS input and applies a token limit", () => {
    expect(buildFtsQuery('routine" OR secret* -- routine')).toBe('"routine" OR "or" OR "secret"')
    expect(buildFtsQuery("a I !")).toBeUndefined()
    expect(buildFtsQuery(Array.from({ length: 20 }, (_, index) => `term${index}`).join(" "))).toBe(
      '"term0" OR "term1" OR "term2" OR "term3" OR "term4" OR "term5" OR "term6" OR "term7" OR "term8" OR "term9" OR "term10" OR "term11"'
    )
  })

  it("removes question noise and resolves relative dates in the owner time zone", () => {
    expect(
      analyzeRetrievalQuery(
        "What did I say yesterday about breakfast?",
        referenceTime,
        "Europe/Stockholm"
      )
    ).toEqual({
      terms: ["breakfast"],
      ftsQuery: '"breakfast"',
      temporal: {
        mode: "during",
        from: "2026-08-09T22:00:00Z",
        to: "2026-08-10T22:00:00Z"
      }
    })
  })

  it("rejects weak lexical noise before importance can promote it", () => {
    const selected = selectRelevantCandidates(
      [candidate("weak", "Breakfast was good")],
      ["breakfast", "allergy", "current"],
      current
    )
    expect(selected).toEqual([])
  })

  it("keeps more than three relevant facts and keeps old stable facts current", () => {
    const selected = selectRelevantCandidates(
      Array.from({ length: 6 }, (_, index) =>
        candidate(`fact-${index}`, `Favorite color detail ${index}`, {
          occurredAt: "2020-01-01T00:00:00.000Z",
          lexicalPosition: index
        })
      ),
      ["favorite", "color"],
      current,
      { limit: 6 }
    )
    expect(selected).toHaveLength(6)
  })

  it("selects the revision valid at the requested time", () => {
    const selected = selectRelevantCandidates(
      [
        candidate("old", "Desk was upstairs", {
          validFrom: "2025-01-01T00:00:00.000Z",
          validTo: "2026-01-01T00:00:00.000Z"
        }),
        candidate("current", "Desk is downstairs", {
          validFrom: "2026-01-01T00:00:00.000Z"
        })
      ],
      ["desk"],
      { mode: "as_of", at: "2025-06-01T23:59:59.999Z" }
    )
    expect(selectedCandidates(selected).map(({ id }) => id)).toEqual(["old"])
  })

  it("marks all simultaneous values for one claim as a conflict", () => {
    const selected = selectRelevantCandidates(
      [
        candidate("a", "Desk is upstairs", { conflictKey: "desk", contentHash: "a" }),
        candidate("b", "Desk is downstairs", {
          conflictKey: "desk",
          contentHash: "b",
          lexicalPosition: 1
        })
      ],
      ["desk"],
      current
    )
    expect(selected).toHaveLength(1)
    expect(selected[0]).toMatchObject({
      kind: "conflict_group",
      conflictKey: "desk",
      candidates: [{ id: "a" }, { id: "b" }]
    })
  })

  it("keeps whole conflict groups and never slices an indexed claim", () => {
    const group = selectRelevantCandidates(
      [
        candidate("a", "1234", { conflictKey: "same", contentHash: "a" }),
        candidate("b", "5678", { conflictKey: "same", contentHash: "b", lexicalPosition: 1 })
      ],
      [],
      current
    )
    expect(boundRetrievalReading(group, { totalCharacters: 7, itemCharacters: 4 })).toEqual([])
    expect(boundRetrievalReading(group, { totalCharacters: 9, itemCharacters: 9 })).toMatchObject([
      { kind: "conflict_group", candidates: [{ id: "a" }, { id: "b" }] }
    ])
    expect(
      boundRetrievalReading([{ kind: "candidate", candidate: rankedCandidate("large", "12345") }], {
        totalCharacters: 10,
        itemCharacters: 4
      })
    ).toEqual([])
  })

  it("reads one copy when matching records contain the same claim value", () => {
    const units = selectRelevantCandidates(
      [
        candidate("first", "Desk is upstairs", { conflictKey: "desk", contentHash: "same" }),
        candidate("second", "Desk is upstairs", {
          conflictKey: "desk",
          contentHash: "same",
          lexicalPosition: 1
        })
      ],
      ["desk"],
      current
    )

    expect(units).toHaveLength(2)
    expect(
      boundRetrievalReading(units, { totalCharacters: 100, itemCharacters: 100 })
    ).toMatchObject([{ kind: "candidate", candidate: { id: "first" } }])
  })
})
