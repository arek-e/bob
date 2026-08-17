import { memoryCapability } from "@bob/memory-types/capability"
import { reminderCapability } from "@bob/reminders-types/capability"
import { makeCapabilityCatalogue } from "@bob/tools-types/catalogue"
import { trainingCapability } from "@bob/training-types/capability"
import { describe, expect, it } from "vitest"

import { agentRunSpanCode, featureForTools, tokenBudgetState } from "../src/attribution.ts"
import { parseHealthEvent } from "../src/events.ts"

const transitionalDeploymentProfile = makeCapabilityCatalogue("telemetry-test", [
  reminderCapability,
  memoryCapability,
  trainingCapability
])

describe("content-free telemetry", () => {
  it("rejects arbitrary content fields", () => {
    expect(() =>
      parseHealthEvent({
        type: "webhook",
        correlationId: "018e6f65-4d55-7a1b-8df4-4ee15ea1db9f",
        status: "accepted",
        code: "accepted",
        durationMs: 3,
        messageText: "private"
      })
    ).toThrow()
  })

  it("keeps token attribution content-free", () => {
    expect(
      parseHealthEvent({
        type: "token_usage",
        correlationId: "018e6f65-4d55-7a1b-8df4-4ee15ea1db9f",
        runId: "018e6f65-4d55-7a1b-8df4-4ee15ea1dba0",
        feature: "reminders",
        workflow: "agent_turn",
        provider: "openai-codex",
        model: "gpt-test",
        status: "completed",
        inputTokens: 120,
        outputTokens: 30,
        toolCalls: 1,
        durationMs: 40
      })
    ).toMatchObject({ type: "token_usage", feature: "reminders" })
  })

  it("rejects private fields on token attribution", () => {
    expect(() =>
      parseHealthEvent({
        type: "token_usage",
        correlationId: "018e6f65-4d55-7a1b-8df4-4ee15ea1db9f",
        runId: "018e6f65-4d55-7a1b-8df4-4ee15ea1dba0",
        feature: "assistant",
        workflow: "agent_turn",
        provider: "openai-codex",
        model: "gpt-test",
        status: "completed",
        inputTokens: 1,
        outputTokens: 1,
        toolCalls: 0,
        durationMs: 1,
        userText: "private"
      })
    ).toThrow()
  })

  it("rejects private values in legacy health labels", () => {
    const common = {
      correlationId: "018e6f65-4d55-7a1b-8df4-4ee15ea1db9f",
      runId: "018e6f65-4d55-7a1b-8df4-4ee15ea1dba0",
      status: "completed" as const,
      durationMs: 1
    }
    expect(() =>
      parseHealthEvent({
        type: "tool_call",
        ...common,
        toolCallId: "private-phone-46700000000",
        toolName: "reminder_list"
      })
    ).toThrow()
    expect(() =>
      parseHealthEvent({
        type: "agent_run",
        ...common,
        model: "private-phone-46700000000",
        inputTokens: 1,
        outputTokens: 1
      })
    ).toThrow()
    expect(() =>
      parseHealthEvent({
        type: "webhook",
        correlationId: common.correlationId,
        status: "failed",
        code: "private-phone-46700000000",
        durationMs: 1
      })
    ).toThrow()
  })
})

describe("usage attribution", () => {
  it("groups tools into stable product features", () => {
    expect(featureForTools(transitionalDeploymentProfile, [])).toBe("assistant")
    expect(
      featureForTools(transitionalDeploymentProfile, ["reminder_create", "reminder_list"])
    ).toBe("reminders")
    expect(featureForTools(transitionalDeploymentProfile, ["memory_search", "workout_last"])).toBe(
      "mixed"
    )
    expect(
      featureForTools(transitionalDeploymentProfile, [
        "reminder_list",
        "memory_search",
        "journal_search_metadata",
        "workout_last",
        "settings_get"
      ])
    ).toBe("assistant")
  })

  it("maps agent failures to stable content-free span codes", () => {
    expect(agentRunSpanCode("completed", undefined)).toBeUndefined()
    expect(agentRunSpanCode("failed", "quota")).toBe("quota")
    expect(agentRunSpanCode("cancelled", undefined)).toBe("cancelled")
  })

  it("uses an eighty-percent warning boundary", () => {
    expect(tokenBudgetState(79, 100)).toBe("within")
    expect(tokenBudgetState(80, 100)).toBe("warning")
    expect(tokenBudgetState(100, 100)).toBe("exceeded")
  })
})
