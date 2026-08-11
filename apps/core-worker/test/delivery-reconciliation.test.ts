import { describe, expect, it, vi } from "vitest"

import { makeDeliveryReconciler } from "../src/modules/delivery/reconciliation.ts"

describe("delivery reconciliation client", () => {
  it("authenticates the request and validates the provider fact", async () => {
    const request = vi.fn(async () =>
      Response.json({
        messageHandle: "provider-1",
        status: "delivered",
        occurredAt: "2026-08-11T10:02:00.000Z"
      })
    )
    const reconciler = makeDeliveryReconciler({
      url: "https://bob-sendblue-egress.example.invalid",
      callerSecret: "caller-secret",
      fetch: request
    })

    await expect(reconciler.readProviderStatus("provider-1")).resolves.toEqual({
      messageHandle: "provider-1",
      status: "delivered",
      occurredAt: "2026-08-11T10:02:00.000Z"
    })
    expect(request).toHaveBeenCalledWith(
      new URL("https://bob-sendblue-egress.example.invalid/internal/reconcile"),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "x-bob-caller-token": "caller-secret" }),
        body: JSON.stringify({ messageHandle: "provider-1" })
      })
    )
  })

  it("rejects an insecure remote endpoint", () => {
    expect(() =>
      makeDeliveryReconciler({ url: "http://example.invalid", callerSecret: "caller-secret" })
    ).toThrow("Sendblue egress URL must use HTTPS")
  })
})
