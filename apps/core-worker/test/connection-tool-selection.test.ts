import { describe, expect, it } from "vitest"

import { selectTools } from "../src/modules/context/tool-selection.ts"

describe("connection tool selection", () => {
  it.each([
    "Connect my Google Calendar.",
    "Link Outlook to Bob.",
    "Koppla min kalender.",
    "Anslut Microsoft Calendar."
  ])("selects connection tools for %s", (text) => {
    expect(selectTools(text)).toEqual(
      expect.arrayContaining(["connection_list", "connection_link_create"])
    )
  })
})
