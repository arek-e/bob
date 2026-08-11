import { describe, expect, it } from "vitest"

import { journalIndexMarkdown } from "../src/journal-export.ts"

describe("Obsidian journal index export", () => {
  it("includes approved metadata but never exports private entry text", () => {
    const markdown = journalIndexMarkdown(
      [
        {
          id: "00000000-0000-4000-8000-000000000001",
          createdAt: "2026-08-11T10:00:00.000Z",
          tags: ["training"],
          approvedSummary: "I completed my routine.",
          text: "A private sentence that must stay in Bob."
        }
      ],
      "2026-08-11T12:00:00.000Z"
    )

    expect(markdown).toContain("# Bob journal index")
    expect(markdown).toContain("I completed my routine.")
    expect(markdown).not.toContain("A private sentence that must stay in Bob.")
  })
})
