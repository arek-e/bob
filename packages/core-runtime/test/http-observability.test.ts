import { makeCaptureTelemetry } from "@bob/observability/testing"
import { Effect } from "effect"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { CoreBindings } from "../src/bindings.ts"
import type { CoreComposition } from "../src/composition.ts"

import { handleHttp } from "../src/entrypoints/http.ts"
import { testFixture } from "./test-fixture.ts"

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
  it("continues inbound confirmation through one server span", async () => {
    const markEnqueued = vi.fn(async () => undefined)
    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    compositionHarness.current = testFixture<CoreComposition>({
      services: { conversations: { markEnqueued } }
    })
    const ingressSecret = "i".repeat(64)
    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    const bindings = testFixture<CoreBindings>({
      INGRESS_CALLER_SECRET: ingressSecret,
      EGRESS_CALLER_SECRET: "e".repeat(64),
      AGENT_CALLER_SUBJECT: "agent",
      ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
      CORE_ACCESS_AUDIENCE: "core"
    })
    const telemetry = makeCaptureTelemetry({
      serviceName: "bob-core-runtime",
      serviceVersion: "0123456789abcdef0123456789abcdef01234567",
      deploymentEnvironment: "test"
    })

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
      undefined,
      {
        runPromise: (effect) => Effect.runPromise(effect.pipe(Effect.provide(telemetry.layer)))
      },
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
      ownerRunCoordinator: { wake },
      services: {
        tools: {
          execute: vi.fn(async () => ({ ok: true, code: "reminder_seen", message: "Seen." })),
          mutationActivity: vi.fn(async () => testCase.activity)
        },
        turns: { releaseSettlingForRun },
        events: { emit: vi.fn(async () => undefined) }
      }
    })
    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    const bindings = testFixture<CoreBindings>({
      INGRESS_CALLER_SECRET: "i".repeat(64),
      EGRESS_CALLER_SECRET: "e".repeat(64),
      AGENT_CALLER_SUBJECT: "agent",
      ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
      CORE_ACCESS_AUDIENCE: "core"
    })
    const response = await handleHttp(
      new Request("https://core.test/internal/tools", {
        method: "POST",
        headers: { "content-type": "application/json" },
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
      async () => ({ subject: "", commonName: "agent", audience: ["core"] }),
      undefined,
      composeTestCore
    )

    expect(response.status).toBe(200)
    expect(releaseSettlingForRun).toHaveBeenCalledTimes(testCase.releases ? 1 : 0)
    expect(wake).toHaveBeenCalledTimes(testCase.releases ? 1 : 0)
  })
})
