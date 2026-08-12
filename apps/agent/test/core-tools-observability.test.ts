import { withBobSpan } from "@bob/observability/effect"
import { parseTraceparent } from "@bob/observability/propagation"
import { makeCaptureTelemetry } from "@bob/observability/testing"
import { Effect } from "effect"
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
    const telemetry = makeCaptureTelemetry({
      serviceName: "bob-agent",
      serviceVersion: "0123456789abcdef0123456789abcdef01234567",
      deploymentEnvironment: "test"
    })
    let outboundTraceparent: string | null = null
    const request = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      outboundTraceparent = headers.get("traceparent")
      expect(headers.get("x-bob-correlation-id")).toBe(correlationId)
      return Response.json({ ok: true, code: "reminder_list", message: "Done" })
    })
    const client = createCoreToolClient({
      coreUrl: "https://core.example.invalid",
      accessClientId: "client",
      accessClientSecret: "secret",
      fetch: request as typeof fetch
    })

    await Effect.runPromise(
      withBobSpan(
        {
          name: "bob.agent.run",
          runId,
          correlationId,
          feature: "reminders"
        },
        withBobSpan(
          {
            name: "bob.tool.invoke",
            runId,
            correlationId,
            feature: "reminders",
            toolName: "reminder_list"
          },
          client.executeEffect({
            runId,
            toolCallId: "tool-1",
            idempotencyKey: "tool:test:1",
            ownerId: "018e6f65-4d55-7a1b-8df4-4ee15ea1dba1",
            name: "reminder_list",
            arguments: {}
          })
        )
      ).pipe(Effect.provide(telemetry.layer))
    )

    const spans = telemetry.finishedSpans()
    const toolSpan = spans.find((span) => span.name === "bob.tool.invoke")
    const trace = parseTraceparent(outboundTraceparent)
    expect(toolSpan).toBeDefined()
    expect(trace).toMatchObject({ traceId: toolSpan?.traceId, spanId: toolSpan?.spanId })
    expect(toolSpan?.parentSpanId).toBe(spans.find((span) => span.name === "bob.agent.run")?.spanId)
    expect(spans.some((span) => span.name === "bob.tool.execute")).toBe(false)
    expect(telemetry.healthEvents()).toEqual([
      expect.objectContaining({
        type: "tool_call",
        correlationId,
        runId,
        toolName: "reminder_list",
        status: "completed"
      })
    ])
    expect(
      JSON.stringify({ spans, health: telemetry.healthEvents() }, (_key, value) =>
        typeof value === "bigint" ? value.toString() : value
      )
    ).not.toContain("arguments")
  })
})
