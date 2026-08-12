import { withBobSpan } from "@bob/observability/effect"
import { Effect } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { CoreBindings } from "../src/bindings.ts"

import { makeCoreTelemetryInvocation } from "../src/telemetry.ts"

const correlationId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db9f"

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("Core Effect telemetry", () => {
  it("exports one content-free Worker span on invocation flush", async () => {
    const requests: Array<{ readonly url: string; readonly init?: RequestInit }> = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({ url: String(input), ...(init === undefined ? {} : { init }) })
        return new Response(null, { status: 200 })
      })
    )
    const telemetry = makeCoreTelemetryInvocation({
      BOB_RELEASE_SHA: "0123456789abcdef0123456789abcdef01234567",
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.example.invalid",
      OTEL_ACCESS_CLIENT_ID: "otel-client",
      OTEL_ACCESS_CLIENT_SECRET: "otel-secret"
    } as CoreBindings)

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
    const headers = new Headers(requests[0]?.init?.headers)
    expect(headers.get("CF-Access-Client-Id")).toBe("otel-client")
    const payload = JSON.parse(String(requests[0]?.init?.body)) as unknown
    expect(payload).toEqual(
      expect.objectContaining({
        resourceSpans: expect.any(Array)
      })
    )
    expect(JSON.stringify(payload)).not.toContain("otel-secret")
  })

  it("keeps telemetry disabled when production export values are absent", async () => {
    const request = vi.fn()
    vi.stubGlobal("fetch", request)
    const telemetry = makeCoreTelemetryInvocation({} as CoreBindings)

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
