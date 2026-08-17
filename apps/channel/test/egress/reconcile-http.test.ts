import { afterEach, describe, expect, it, vi } from "vitest"

import type { EgressBindings } from "../../src/egress/bindings.ts"

import { handleReconcileRequest } from "../runtime.ts"

const callerToken = "c".repeat(64)
// SAFETY: This controlled test fixture matches the asserted contract used by this test.
const bindings = {
  CORE: { fetch: vi.fn(), connect: vi.fn() },
  INGRESS: { fetch: vi.fn(), connect: vi.fn() },
  DELIVERY_RESULT_QUEUE: {
    send: vi.fn(),
    sendBatch: vi.fn(),
    metrics: vi.fn()
  },
  SENDBLUE_API_KEY_ID: "key",
  SENDBLUE_API_SECRET_KEY: "secret",
  SENDBLUE_WEBHOOK_SIGNING_SECRET: "s".repeat(64),
  SENDBLUE_FROM_NUMBER: "+46711111111",
  SENDBLUE_STATUS_CALLBACK_URL: "https://ingress.example.invalid/webhooks/outbound",
  CORE_CALLER_SECRET: callerToken,
  OTEL_EXPORTER_OTLP_ENDPOINT: "",
  BOB_RELEASE_SHA: ""
} as EgressBindings

function reconcileRequest(token = callerToken) {
  return new Request("https://egress.example.invalid/internal/inbound-reconcile", {
    method: "POST",
    headers: { "x-bob-caller-token": token }
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("Sendblue inbound reconciliation endpoint", () => {
  it("rejects unauthenticated requests before provider access", async () => {
    const providerFetch = vi.fn()
    vi.stubGlobal("fetch", providerFetch)

    const response = await handleReconcileRequest(reconcileRequest("wrong"), bindings)

    expect(response.status).toBe(401)
    expect(providerFetch).not.toHaveBeenCalled()
  })

  it("runs recovery for an authenticated core request", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.endsWith("/api/lines")) {
          return Response.json({ numbers: ["+46711111111"] })
        }
        if (url.startsWith("https://api.sendblue.com/api/v2/messages?")) {
          return Response.json({ status: "OK", data: [], pagination: { total: 0 } })
        }
        throw new Error("unexpected_request")
      })
    )

    const response = await handleReconcileRequest(reconcileRequest(), bindings)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ retrieved: 0, replayed: 0, skipped: 0 })
  })
})
