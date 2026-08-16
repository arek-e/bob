import { describe, expect, it } from "vitest"

import { buildSendblueStatusCallback, readSendblueStatusCallback } from "../src/status-callback.ts"

const outboxId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db9f"
const attemptId = "018e6f65-4d55-7a1b-8df4-4ee15ea1dba0"
const correlationId = "018e6f65-4d55-7a1b-8df4-4ee15ea1dba1"
const traceparent = "00-018e6f654d557a1b8df44ee15ea1dba1-1111111111111111-01"

describe("Sendblue status callback", () => {
  it("keeps the complete delivery context below the provider limit", () => {
    const callback = buildSendblueStatusCallback("https://bob.example/webhooks/outbound", {
      outboxId,
      attemptId,
      correlationId,
      traceparent
    })

    expect(callback.length).toBeLessThanOrEqual(255)
    expect([...new URL(callback).searchParams.entries()]).toEqual([
      ["o", outboxId],
      ["a", attemptId],
      ["c", correlationId],
      ["t", traceparent]
    ])
  })

  it("drops correlation telemetry before it exceeds the provider limit", () => {
    const callback = buildSendblueStatusCallback(`https://bob.example/${"x".repeat(70)}`, {
      outboxId,
      attemptId,
      correlationId,
      traceparent
    })
    const parameters = new URL(callback).searchParams

    expect(callback.length).toBeLessThanOrEqual(255)
    expect(parameters.get("o")).toBe(outboxId)
    expect(parameters.get("a")).toBe(attemptId)
    expect(parameters.get("c")).toBeNull()
    expect(parameters.get("t")).toBe(traceparent)
  })

  it("drops trace telemetry when routing is the only context that fits", () => {
    const callback = buildSendblueStatusCallback(`https://bob.example/${"x".repeat(109)}`, {
      outboxId,
      attemptId,
      correlationId,
      traceparent
    })
    const parameters = new URL(callback).searchParams

    expect(callback.length).toBeLessThanOrEqual(255)
    expect(parameters.get("o")).toBe(outboxId)
    expect(parameters.get("a")).toBe(attemptId)
    expect(parameters.get("c")).toBeNull()
    expect(parameters.get("t")).toBeNull()
  })

  it("rejects a callback when its required routing context cannot fit", () => {
    expect(() =>
      buildSendblueStatusCallback(`https://bob.example/${"x".repeat(180)}`, {
        outboxId,
        attemptId,
        correlationId,
        traceparent
      })
    ).toThrow("sendblue_status_callback_too_long")
  })

  it("reads the compact callback context", () => {
    const callback = new URL("https://bob.example/webhooks/outbound")
    callback.searchParams.set("o", outboxId)
    callback.searchParams.set("a", attemptId)
    callback.searchParams.set("c", correlationId)
    callback.searchParams.set("t", traceparent)

    expect(readSendblueStatusCallback(callback)).toEqual({
      outboxId,
      attemptId,
      correlationId,
      traceparent
    })
  })

  it("reads the existing long callback keys", () => {
    const callback = new URL("https://bob.example/webhooks/outbound")
    callback.searchParams.set("outbox_id", outboxId)
    callback.searchParams.set("attempt_id", attemptId)
    callback.searchParams.set("correlation_id", correlationId)
    callback.searchParams.set("traceparent", traceparent)

    expect(readSendblueStatusCallback(callback)).toEqual({
      outboxId,
      attemptId,
      correlationId,
      traceparent
    })
  })
})
