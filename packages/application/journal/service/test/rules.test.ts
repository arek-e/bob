import { describe, expect, it } from "vitest"

import { journalAgentMetadata, journalModelContext } from "../src/rules.ts"

describe("Journal rules", () => {
  it("does not return raw journal text to the model", () => {
    expect(
      journalModelContext({
        id: "entry",
        createdAt: "2026-08-11T00:00:00.000Z",
        tags: ["private"],
        rawText: "secret"
      })
    ).toBeUndefined()
  })

  it("keeps summaries and entry IDs out of agent metadata", () => {
    expect(
      journalAgentMetadata({
        id: "private-entry-id",
        createdAt: "2026-08-11T00:00:00.000Z",
        tags: ["training"],
        approvedSummary: "Private approved summary",
        rawText: "Private journal text"
      })
    ).toEqual({ createdAt: "2026-08-11T00:00:00.000Z", tags: ["training"] })
  })
})
