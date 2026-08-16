import { transitionalDeploymentProfile } from "@bob/core-types/profiles"
import { describe, expect, it, vi } from "vitest"

import { agentRunSpanCode, featureForTools, tokenBudgetState } from "../src/attribution.ts"
import { observeHealth, parseHealthEvent } from "../src/events.ts"
import { captureEvents } from "../src/testing.ts"
import {
  formatTraceparent,
  observeSpan,
  parseTraceparent,
  traceContextFromCorrelationId
} from "../src/trace.ts"

describe("content-free telemetry", () => {
  it("keeps validation and sink failures outside application control flow", async () => {
    const emit = vi.fn(() => {
      throw new Error("unavailable")
    })
    await expect(
      observeHealth(
        { emit },
        {
          type: "webhook",
          correlationId: "018e6f65-4d55-7a1b-8df4-4ee15ea1db9f",
          status: "accepted",
          code: "accepted",
          durationMs: 3
        }
      )
    ).resolves.toBeUndefined()
    expect(emit).toHaveBeenCalledOnce()
  })

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

describe("trace context", () => {
  const correlationId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db9f"

  it("creates one W3C trace from an opaque correlation identifier", () => {
    const context = traceContextFromCorrelationId(correlationId, (length) =>
      new Uint8Array(length).fill(1)
    )
    expect(context.traceId).toBe(correlationId.replaceAll("-", ""))
    expect(parseTraceparent(formatTraceparent(context))).toEqual(context)
    expect(
      parseTraceparent("00-00000000000000000000000000000000-0101010101010101-01")
    ).toBeUndefined()
  })

  it("emits completed and failed spans without changing results", async () => {
    const events = captureEvents()
    const parent = traceContextFromCorrelationId(correlationId, (length) =>
      new Uint8Array(length).fill(1)
    )
    let tick = 10
    await expect(
      observeSpan(
        {
          sink: events,
          correlationId,
          parent,
          name: "model.run",
          feature: "assistant",
          workflow: "agent_turn",
          now: () => (tick += 5),
          randomBytes: (length) => new Uint8Array(length).fill(2)
        },
        async () => "ok"
      )
    ).resolves.toBe("ok")
    await expect(
      observeSpan(
        {
          sink: events,
          correlationId,
          parent,
          name: "provider.send",
          feature: "delivery",
          workflow: "outbound_delivery",
          failureCode: "network",
          now: () => (tick += 5),
          randomBytes: (length) => new Uint8Array(length).fill(3)
        },
        async () => Promise.reject(new Error("private provider response"))
      )
    ).rejects.toThrow("private provider response")
    expect(events.events).toEqual([
      expect.objectContaining({ type: "workflow_span", status: "completed", code: "ok" }),
      expect.objectContaining({ type: "workflow_span", status: "failed", code: "network" })
    ])
    expect(JSON.stringify(events.events)).not.toContain("private provider response")
  })

  it("marks a returned failure without changing the operation result", async () => {
    const events = captureEvents()
    const parent = traceContextFromCorrelationId(correlationId, (length) =>
      new Uint8Array(length).fill(1)
    )
    const result = { ok: false as const }
    await expect(
      observeSpan(
        {
          sink: events,
          correlationId,
          parent,
          name: "tool.execute",
          feature: "reminders",
          workflow: "tool_execution",
          randomBytes: (length) => new Uint8Array(length).fill(2)
        },
        async () => result,
        (value) => (value.ok ? undefined : "tool_execution")
      )
    ).resolves.toBe(result)
    expect(events.events).toContainEqual(
      expect.objectContaining({
        type: "workflow_span",
        status: "failed",
        code: "tool_execution"
      })
    )
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
