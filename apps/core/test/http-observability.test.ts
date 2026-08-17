import type { CoreBindings } from "@bob/core-types/bindings"

import { makeCaptureTelemetry } from "@bob/observability"
import { Effect, Layer, ManagedRuntime } from "effect"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { CoreComposition } from "../src/composition.ts"

import { testFixture } from "../../../packages/core/service/test/test-fixture.ts"
import { handleHttp } from "../src/entrypoints/http.ts"

const compositionHarness = vi.hoisted(() => ({
  // SAFETY: This focused test double implements every platform member exercised by this test.
  current: undefined as CoreComposition | undefined
}))

function composeTestCore(): CoreComposition {
  if (compositionHarness.current === undefined) throw new Error("Test composition is not set")
  return compositionHarness.current
}

const inboundId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db90"
const correlationId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db91"
const traceId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const parentSpanId = "1111111111111111"

beforeEach(() => {
  compositionHarness.current = undefined
})

describe("Core HTTP telemetry", () => {
  it("stores and serves a run-scoped image through the attachment Interface", async () => {
    const eventId = "018e6f65-4d55-7a1b-8df4-4ee15ea1dba3"
    const runId = "018e6f65-4d55-7a1b-8df4-4ee15ea1dba4"
    const attachmentId = "018e6f65-4d55-7a1b-8df4-4ee15ea1dba5"
    const body = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const reference = {
      id: attachmentId,
      mediaType: "image/png" as const,
      byteLength: body.byteLength,
      contentHash: "attachment-hash"
    }
    const storeInbound = vi.fn(() => Effect.succeed(reference))
    const loadForAgent = vi.fn(() => Effect.succeed({ ...reference, body }))
    compositionHarness.current = testFixture<CoreComposition>({
      services: { attachments: { storeInbound, loadForAgent } }
    })
    const ingressSecret = "i".repeat(64)
    const agentSecret = "a".repeat(64)
    const bindings = testFixture<CoreBindings>({
      INGRESS_CALLER_SECRET: ingressSecret,
      EGRESS_CALLER_SECRET: "e".repeat(64),
      AGENT_CALLER_SECRET: agentSecret
    })

    const stored = await handleHttp(
      new Request(`https://core.test/internal/inbound/${eventId}/attachments/0`, {
        method: "PUT",
        headers: {
          "content-type": "image/png",
          "x-bob-caller-token": ingressSecret
        },
        body
      }),
      bindings,
      composeTestCore
    )
    const loaded = await handleHttp(
      new Request(`https://core.test/internal/agent/runs/${runId}/attachments/${attachmentId}`, {
        headers: { "x-bob-caller-token": agentSecret }
      }),
      bindings,
      composeTestCore
    )

    expect(stored.status).toBe(201)
    expect(await stored.json()).toEqual(reference)
    expect(storeInbound).toHaveBeenCalledWith(eventId, 0, "image/png", body)
    expect(loaded.status).toBe(200)
    expect(loaded.headers.get("cache-control")).toBe("no-store")
    expect(new Uint8Array(await loaded.arrayBuffer())).toEqual(body)
    expect(loadForAgent).toHaveBeenCalledWith(runId, attachmentId)
  })

  it("continues inbound confirmation through one server span", async () => {
    const markEnqueued = vi.fn(async () => undefined)
    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    const ingressSecret = "i".repeat(64)
    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    const bindings = testFixture<CoreBindings>({
      INGRESS_CALLER_SECRET: ingressSecret,
      EGRESS_CALLER_SECRET: "e".repeat(64),
      AGENT_CALLER_SECRET: "a".repeat(64)
    })
    const telemetry = makeCaptureTelemetry({
      serviceName: "bob-core-runtime",
      serviceVersion: "0123456789abcdef0123456789abcdef01234567",
      deploymentEnvironment: "test"
    })
    const baseComposition = testFixture<CoreComposition>({
      services: { conversations: { markEnqueued } }
    })
    const layer = Layer.merge(baseComposition.layer, telemetry.layer)
    compositionHarness.current = {
      ...baseComposition,
      layer,
      runtime: ManagedRuntime.make(layer)
    }

    const response = await handleHttp(
      new Request(`https://core.test/internal/inbound/${inboundId}/enqueued`, {
        method: "POST",
        headers: {
          traceparent: `00-${traceId}-${parentSpanId}-01`,
          "x-bob-caller-token": ingressSecret,
          "x-bob-correlation-id": correlationId
        }
      }),
      bindings,
      composeTestCore
    )

    expect(response.status).toBe(200)
    expect(markEnqueued).toHaveBeenCalledOnce()
    expect(telemetry.finishedSpans()).toEqual([
      expect.objectContaining({
        name: "bob.inbound.confirm_accept",
        traceId,
        parentSpanId,
        kind: "server",
        attributes: expect.objectContaining({ "bob.correlation.id": correlationId })
      })
    ])
  })

  it.each([
    { label: "terminal", activity: { status: "completed", completedInRun: true }, releases: true },
    { label: "unknown", activity: { status: "unknown" }, releases: true },
    {
      label: "active",
      activity: {
        status: "active",
        retryAt: "2026-08-12T10:01:00.000Z",
        recoveryRequired: false,
        recoveryExhausted: false,
        originRevision: 1
      },
      releases: false
    }
  ] as const)("wakes a settling turn only after $label mutation activity", async (testCase) => {
    const runId = "018e6f65-4d55-7a1b-8df4-4ee15ea1dba0"
    const ownerId = "018e6f65-4d55-7a1b-8df4-4ee15ea1dba1"
    const releaseSettlingForRun = vi.fn(async () =>
      testCase.releases ? { ownerId, quietUntil: "2026-08-12T10:00:00.000Z" } : undefined
    )
    const wake = vi.fn(async () => new Response(null, { status: 200 }))
    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    compositionHarness.current = testFixture<CoreComposition>({
      runCoordinator: { wake },
      services: {
        tools: {
          execute: vi.fn(async () => ({ ok: true, code: "reminder_seen", message: "Seen." })),
          mutationActivity: vi.fn(async () => testCase.activity)
        },
        turns: { releaseSettlingForRun }
      }
    })
    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    const bindings = testFixture<CoreBindings>({
      INGRESS_CALLER_SECRET: "i".repeat(64),
      EGRESS_CALLER_SECRET: "e".repeat(64),
      AGENT_CALLER_SECRET: "a".repeat(64)
    })
    const response = await handleHttp(
      new Request("https://core.test/internal/tools", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-bob-caller-token": "a".repeat(64)
        },
        body: JSON.stringify({
          runId,
          toolCallId: "tool-call",
          idempotencyKey: "tool:test:http-wake",
          ownerId,
          name: "reminder_acknowledge",
          arguments: { occurrenceId: "018e6f65-4d55-7a1b-8df4-4ee15ea1dba2" }
        })
      }),
      bindings,
      composeTestCore
    )

    expect(response.status).toBe(200)
    expect(releaseSettlingForRun).toHaveBeenCalledTimes(testCase.releases ? 1 : 0)
    expect(wake).toHaveBeenCalledTimes(testCase.releases ? 1 : 0)
  })
})
