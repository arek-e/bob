import { afterEach, describe, expect, it, vi } from "vitest"

import { handleEgressHttp } from "../src/entrypoints/http.ts"

function bindings() {
  return {
    SENDBLUE_API_KEY_ID: "key-id",
    SENDBLUE_API_SECRET_KEY: "secret-key",
    CORE_CALLER_SECRET: "c".repeat(64)
  } as never
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("Sendblue egress reconciliation", () => {
  it("rejects a request without the Core caller secret", async () => {
    const response = await handleEgressHttp(
      new Request("https://egress.example/internal/reconcile", {
        method: "POST",
        body: JSON.stringify({ messageHandle: "provider-1" })
      }),
      bindings()
    )

    expect(response.status).toBe(401)
  })

  it("returns one validated provider status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          message_handle: "provider-1",
          status: "DELIVERED",
          date_updated: "2026-08-11T10:02:00.000Z"
        })
      )
    )
    const response = await handleEgressHttp(
      new Request("https://egress.example/internal/reconcile", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-bob-caller-token": "c".repeat(64)
        },
        body: JSON.stringify({ messageHandle: "provider-1" })
      }),
      bindings()
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      messageHandle: "provider-1",
      status: "delivered",
      occurredAt: "2026-08-11T10:02:00.000Z"
    })
  })
})
