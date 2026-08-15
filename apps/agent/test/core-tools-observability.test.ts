import { transitionalDeploymentProfile } from "@bob/contracts/deployment-profiles"
import { withBobSpan } from "@bob/observability/effect"
import { parseTraceparent } from "@bob/observability/propagation"
import { makeCaptureTelemetry } from "@bob/observability/testing"
import { Effect } from "effect"
import { describe, expect, it, vi } from "vitest"

import { createCoreToolClient } from "../src/core-tools.ts"

const runId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db9f"
const correlationId = "018e6f65-4d55-7a1b-8df4-4ee15ea1dba0"

describe("agent tool telemetry", () => {
  it("keeps one mutation request attached past the read timeout", async () => {
    vi.useFakeTimers()
    let requestSignal: AbortSignal | null | undefined
    let markStarted!: () => void
    let finishRequest!: (response: Response) => void
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const response = new Promise<Response>((resolve) => {
      finishRequest = resolve
    })
    const request = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestSignal = init?.signal
      markStarted()
      return response
    })
    const client = createCoreToolClient({
      catalogue: transitionalDeploymentProfile,
      coreUrl: "https://core.example.invalid",
      accessClientId: "client",
      accessClientSecret: "secret",
      // SAFETY: This controlled test fixture matches the asserted contract used by this test.
      fetch: request as typeof fetch
    })
    const controller = new AbortController()
    const execution = client.execute(
      {
        runId,
        toolCallId: "slow-mutation",
        idempotencyKey: "tool:test:slow-mutation",
        ownerId: "018e6f65-4d55-7a1b-8df4-4ee15ea1dba1",
        name: "settings_update",
        arguments: { timeZone: "Europe/Stockholm" }
      },
      controller.signal
    )

    await started
    let settled = false
    void execution.finally(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(15_001)
    const pendingAfterReadTimeout = !settled
    const usesRunSignal = requestSignal === controller.signal
    finishRequest(Response.json({ ok: true, code: "owner_settings_updated", message: "Done" }))

    try {
      await expect(execution).resolves.toMatchObject({ ok: true })
      expect(pendingAfterReadTimeout).toBe(true)
      expect(usesRunSignal).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it("bounds a mutation without a run signal at 65 seconds", async () => {
    let timeoutMs: number | undefined
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
      timeoutMs = milliseconds
      return new AbortController().signal
    })
    const client = createCoreToolClient({
      catalogue: transitionalDeploymentProfile,
      coreUrl: "https://core.example.invalid",
      accessClientId: "client",
      accessClientSecret: "secret",
      // SAFETY: This controlled test fixture matches the asserted contract used by this test.
      fetch: vi.fn(async () =>
        Response.json({ ok: true, code: "owner_settings_updated", message: "Done" })
      ) as typeof fetch
    })

    try {
      await client.execute({
        runId,
        toolCallId: "bounded-mutation",
        idempotencyKey: "tool:test:bounded-mutation",
        ownerId: "018e6f65-4d55-7a1b-8df4-4ee15ea1dba1",
        name: "settings_update",
        arguments: { timeZone: "Europe/Stockholm" }
      })
      expect(timeoutMs).toBe(65_000)
    } finally {
      timeout.mockRestore()
    }
  })

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
      catalogue: transitionalDeploymentProfile,
      coreUrl: "https://core.example.invalid",
      accessClientId: "client",
      accessClientSecret: "secret",
      // SAFETY: This controlled test fixture matches the asserted contract used by this test.
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
      catalogue: transitionalDeploymentProfile,
      coreUrl: "https://core.example.invalid",
      accessClientId: "client",
      accessClientSecret: "secret",
      // SAFETY: This controlled test fixture matches the asserted contract used by this test.
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
        value !== null && value !== undefined && value.constructor === BigInt
          ? value.toString()
          : value
      )
    ).not.toContain("arguments")
  })
})
