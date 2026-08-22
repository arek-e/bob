import { describe, expect, it } from "vitest"

import { isContextEligibleReply } from "../src/context-sources.ts"

describe("conversation context reply policy", () => {
  it.each(["agent_boundary_fallback", "agent_degraded_recall", "agent_failure"])(
    "excludes %s from future context",
    (reasonCode) => {
      expect(isContextEligibleReply(reasonCode)).toBe(false)
    }
  )

  it.each(["agent_reply", "urgent_safety", "reminder_due"])(
    "keeps %s as conversation evidence",
    (reasonCode) => {
      expect(isContextEligibleReply(reasonCode)).toBe(true)
    }
  )
})
