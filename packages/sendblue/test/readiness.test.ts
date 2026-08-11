import { describe, expect, it, vi } from "vitest"

import type { ReconcilePlan, RequiredWebhooks } from "../src/account.ts"

import { planWebhookReconciliation } from "../src/account.ts"
import { createSendblueReadiness } from "../src/readiness.ts"

const requiredWebhooks: RequiredWebhooks = {
  receiveUrl: "https://sendblue.example.test/webhooks/receive",
  outboundUrl: "https://sendblue.example.test/webhooks/outbound",
  globalSecret: "secret"
}

const completePlan: ReconcilePlan = {
  secretMatches: true,
  receiveCount: 1,
  outboundCount: 1,
  additions: [],
  valid: true,
  complete: true
}

describe("Sendblue account readiness", () => {
  it("marks a valid account plan incomplete when a Bob hook is missing", async () => {
    const plan = await planWebhookReconciliation(
      { webhooks: { receive: [], outbound: [], globalSecret: "secret" } },
      requiredWebhooks
    )

    expect(plan.valid).toBe(true)
    expect(plan.complete).toBe(false)
  })

  it("proves ingress, account hooks, and delivery status before PING", async () => {
    const reconcile = vi.fn(async () => completePlan)
    const getStatus = vi.fn(async (messageHandle: string) => ({
      messageHandle,
      status: "delivered" as const,
      occurredAt: "2026-08-11T10:02:00.000Z"
    }))
    const request = vi.fn(async () =>
      Response.json({ healthy: true, service: "sendblue-ingress", version: 1 })
    )
    const readiness = createSendblueReadiness({
      account: { reconcile },
      delivery: { getStatus },
      fetch: request
    })

    await expect(
      readiness.run({ requiredWebhooks, messageHandle: "provider-1", checkOnly: true })
    ).resolves.toMatchObject({
      ingressHealthUrl: "https://sendblue.example.test/health",
      readyForPing: true,
      nextAction: "Ask the allowlisted owner to send PING."
    })
    expect(reconcile).toHaveBeenCalledWith(requiredWebhooks, true)
    expect(getStatus).toHaveBeenCalledWith("provider-1")
  })

  it("stops before delivery status when required hooks are missing", async () => {
    const getStatus = vi.fn()
    const readiness = createSendblueReadiness({
      account: {
        reconcile: async () => ({
          ...completePlan,
          outboundCount: 0,
          additions: [{ type: "outbound", url: requiredWebhooks.outboundUrl }],
          complete: false
        })
      },
      delivery: { getStatus },
      fetch: async () => Response.json({ healthy: true, service: "sendblue-ingress", version: 1 })
    })

    const report = await readiness.run({
      requiredWebhooks,
      messageHandle: "provider-1",
      checkOnly: true
    })
    expect(report).toMatchObject({
      readyForPing: false,
      nextAction: "Run the apply command to add the missing Bob webhook endpoints."
    })
    expect(report).not.toHaveProperty("deliveryStatus")
    expect(getStatus).not.toHaveBeenCalled()
  })

  it("rejects webhook URLs from different ingress origins", async () => {
    const readiness = createSendblueReadiness({
      account: { reconcile: async () => completePlan },
      delivery: { getStatus: vi.fn() },
      fetch: vi.fn()
    })

    await expect(
      readiness.run({
        requiredWebhooks: {
          ...requiredWebhooks,
          outboundUrl: "https://other.example.test/webhooks/outbound"
        },
        messageHandle: "provider-1",
        checkOnly: true
      })
    ).rejects.toThrow("Sendblue webhook URLs must use one ingress origin")
  })
})
