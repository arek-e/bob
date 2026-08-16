import type { CoreBindings } from "@bob/core-types/bindings"

import { withBobSpan } from "@bob/observability/effect"
import { Effect } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"

import { makeCoreTelemetryInvocation } from "../src/telemetry.ts"
import { testFixture } from "./test-fixture.ts"

const correlationId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db9f"

interface CapturedRequest {
  url: string
  init?: RequestInit
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("Core Effect telemetry", () => {
  it("exports one content-free span on invocation flush", async () => {
    const requests: CapturedRequest[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request: CapturedRequest = { url: String(input) }
        if (init !== undefined) request.init = init
        requests.push(request)
        return new Response(null, { status: 200 })
      })
    )
    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    const telemetry = makeCoreTelemetryInvocation(
      testFixture<CoreBindings>({
        BOB_RELEASE_SHA: "0123456789abcdef0123456789abcdef01234567",
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.example.invalid"
      })
    )

    await telemetry.runPromise(
      withBobSpan(
        {
          name: "bob.inbound.accept",
          correlationId,
          feature: "assistant"
        },
        Effect.void
      )
    )
    await telemetry.flush()

    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe("https://otel.example.invalid/v1/traces")
    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    const payload = JSON.parse(String(requests[0]?.init?.body)) as unknown
    expect(payload).toEqual(
      expect.objectContaining({
        resourceSpans: expect.any(Array)
      })
    )
  })

  it("keeps telemetry disabled when production export values are absent", async () => {
    const request = vi.fn()
    vi.stubGlobal("fetch", request)
    // SAFETY: This focused test double implements every platform member exercised by this test.
    const telemetry = makeCoreTelemetryInvocation(testFixture<CoreBindings>({}))

    await telemetry.runPromise(
      withBobSpan(
        {
          name: "bob.inbound.accept",
          correlationId,
          feature: "assistant"
        },
        Effect.void
      )
    )
    await telemetry.flush()

    expect(request).not.toHaveBeenCalled()
  })
})
