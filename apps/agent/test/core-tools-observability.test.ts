import { runWithNodeTelemetryContext } from "@bob/observability/node"
import { captureEvents } from "@bob/observability/testing"
import { parseTraceparent, traceContextFromCorrelationId } from "@bob/observability/trace"
import { describe, expect, it, vi } from "vitest"

import { createCoreToolClient } from "../src/core-tools.ts"

const runId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db9f"
const correlationId = "018e6f65-4d55-7a1b-8df4-4ee15ea1dba0"

describe("agent tool telemetry", () => {
  it("forwards the agent run abort signal to Core", async () => {
    let requestSignal: AbortSignal | null | undefined
    const request = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestSignal = init?.signal
      return await new Promise<Response>((_resolve, reject) => {
        if (requestSignal?.aborted === true) {
          reject(requestSignal.reason)
          return
        }
        requestSignal?.addEventListener("abort", () => reject(requestSignal?.reason), {
          once: true
        })
      })
    })
    const client = createCoreToolClient({
      coreUrl: "https://core.example.invalid",
      accessClientId: "client",
      accessClientSecret: "secret",
      fetch: request as typeof fetch
    })
    const controller = new AbortController()
    const execution = client.execute(
      {
        runId,
        toolCallId: "tool-abort",
        idempotencyKey: "tool:test:abort",
        ownerId: "018e6f65-4d55-7a1b-8df4-4ee15ea1dba1",
        name: "reminder_list",
        arguments: {}
      },
      controller.signal
    )

    controller.abort("agent_run_timeout")

    await expect(execution).rejects.toBe("agent_run_timeout")
    expect(requestSignal?.aborted).toBe(true)
  })

  it("propagates the active trace and emits no tool arguments", async () => {
    const events = captureEvents()
    const request = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      const trace = parseTraceparent(headers.get("traceparent"))
      expect(trace?.traceId).toBe(correlationId.replaceAll("-", ""))
      expect(headers.get("x-bob-correlation-id")).toBe(correlationId)
      return Response.json({ ok: true, code: "reminder_list", message: "Done" })
    })
    const client = createCoreToolClient({
      coreUrl: "https://core.example.invalid",
      accessClientId: "client",
      accessClientSecret: "secret",
      fetch: request as typeof fetch,
      events
    })
    await runWithNodeTelemetryContext(
      {
        correlationId,
        trace: traceContextFromCorrelationId(correlationId, (length) =>
          new Uint8Array(length).fill(1)
        ),
        feature: "reminders",
        workflow: "agent_turn"
      },
      () =>
        client.execute({
          runId,
          toolCallId: "tool-1",
          idempotencyKey: "tool:test:1",
          ownerId: "018e6f65-4d55-7a1b-8df4-4ee15ea1dba1",
          name: "reminder_list",
          arguments: {}
        })
    )
    expect(events.events).toEqual([
      expect.objectContaining({
        type: "workflow_span",
        name: "tool.execute",
        feature: "reminders",
        status: "completed"
      }),
      expect.objectContaining({
        type: "tool_call",
        correlationId,
        runId,
        toolCallId: "tool-1",
        toolName: "reminder_list",
        status: "completed"
      })
    ])
    expect(JSON.stringify(events.events)).not.toContain("arguments")
  })
})
