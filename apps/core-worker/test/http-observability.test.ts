import { makeCaptureTelemetry } from "@bob/observability/testing"
import { Effect } from "effect"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { CoreBindings } from "../src/bindings.ts"
import type { CoreComposition } from "../src/composition.ts"

import { handleHttp } from "../src/entrypoints/http.ts"

const compositionHarness = vi.hoisted(() => ({
  current: undefined as CoreComposition | undefined
}))

vi.mock("../src/composition.ts", () => ({
  composeCore: () => compositionHarness.current
}))

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
    compositionHarness.current = {
      services: { conversations: { markEnqueued } }
    } as unknown as CoreComposition
    const ingressSecret = "i".repeat(64)
    const bindings = {
      INGRESS_CALLER_SECRET: ingressSecret,
      EGRESS_CALLER_SECRET: "e".repeat(64),
      AGENT_CALLER_SUBJECT: "agent",
      ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
      CORE_ACCESS_AUDIENCE: "core"
    } as CoreBindings
    const telemetry = makeCaptureTelemetry({
      serviceName: "bob-core-worker",
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
      }
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
})
