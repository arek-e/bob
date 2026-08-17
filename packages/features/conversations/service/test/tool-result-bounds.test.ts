import { MAX_TOOL_RESULT_BYTES } from "@bob/capabilities-types/tools"
import { boundToolResult } from "@bob/conversations-service/tool-executor"
import { describe, expect, it } from "vitest"

const oversizedData = { text: "x".repeat(MAX_TOOL_RESULT_BYTES) }

describe("Tool result checkpoint bounds", () => {
  it("turns an oversized read result into a bounded failure", () => {
    expect(
      boundToolResult({
        ok: true,
        code: "memory_results",
        message: "Sources found.",
        data: oversizedData
      })
    ).toEqual({
      ok: false,
      code: "tool_result_too_large",
      message: "The tool returned too much data. Use a narrower request."
    })
  })

  it("retains confirmed mutation evidence in an oversized result", () => {
    expect(
      boundToolResult({
        ok: true,
        code: "action_completed",
        message: "The action finished.",
        data: oversizedData,
        evidence: { actionOutcome: "confirmed" }
      })
    ).toEqual({
      ok: true,
      code: "tool_result_too_large",
      message: "The action finished, but its detailed result was too large.",
      evidence: { actionOutcome: "confirmed" }
    })
  })

  it("retains unknown mutation evidence in an oversized result", () => {
    expect(
      boundToolResult({
        ok: false,
        code: "external_outcome_unknown",
        message: "The action result is unknown.",
        data: oversizedData,
        evidence: { actionOutcome: "unknown" }
      })
    ).toEqual({
      ok: false,
      code: "external_outcome_unknown",
      message: "The action result is unknown. Review the current state before trying again.",
      evidence: { actionOutcome: "unknown" }
    })
  })
})
