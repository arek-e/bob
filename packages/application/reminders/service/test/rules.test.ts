import { describe, expect, it } from "vitest"

import { nextRecurringDueAt, resolveLocalDueAt, transitionOccurrence } from "../src/rules.ts"

describe("Reminder rules", () => {
  it("uses the earlier offset when Stockholm local time repeats", () => {
    expect(resolveLocalDueAt("2026-10-25", "02:30", "Europe/Stockholm")).toBe(
      "2026-10-25T00:30:00Z"
    )
  })

  it("shifts forward when a local time does not exist", () => {
    expect(resolveLocalDueAt("2026-03-29", "02:30", "Europe/Stockholm")).toBe(
      "2026-03-29T01:30:00Z"
    )
  })

  it("keeps recurring wall time over daylight-saving changes", () => {
    expect(
      nextRecurringDueAt("2026-03-28T08:00:00Z", "FREQ=DAILY;INTERVAL=1", "Europe/Stockholm")
    ).toBe("2026-03-29T07:00:00Z")
  })

  it("rejects delivery as task acknowledgment", () => {
    expect(() => transitionOccurrence("awaiting_delivery", "acknowledged")).toThrow()
  })
})
