import {
  decodeWebhookPayload,
  normalizeInbound,
  normalizeStatus,
  timingSafeEqual
} from "@bob/sendblue-types/webhooks"
import { describe, expect, it } from "vitest"

import { createAccountClient, planWebhookReconciliation } from "../src/account.ts"

const payload = {
  accountEmail: "owner@example.invalid",
  content: "PING",
  is_outbound: false,
  status: "RECEIVED",
  error_code: null,
  error_message: null,
  error_reason: null,
  message_handle: "handle-1",
  date_sent: "2026-08-11T10:00:00.000Z",
  date_updated: "2026-08-11T10:00:00.000Z",
  from_number: "+46700000000",
  number: "+46700000000",
  to_number: "+46711111111",
  was_downgraded: null,
  plan: "dedicated",
  media_url: "",
  message_type: "message",
  group_id: "",
  participants: ["+46700000000", "+46711111111"],
  send_style: "",
  opted_out: false,
  error_detail: null,
  sendblue_number: "+46711111111",
  service: "iMessage",
  group_display_name: null
}

describe("Sendblue webhook handling", () => {
  it("compares the shared secret", async () => {
    await expect(timingSafeEqual("right", "right")).resolves.toBe(true)
    await expect(timingSafeEqual("wrong", "right")).resolves.toBe(false)
  })

  it("normalizes only the required message fields", () => {
    const event = normalizeInbound(decodeWebhookPayload(payload), {
      accountId: "account-1",
      lineId: "line-1",
      randomUuid: () => "018e6f65-4d55-7a1b-8df4-4ee15ea1db9f"
    })
    expect(event.text).toBe("PING")
    expect(event.messageHandle).toBe("handle-1")
    expect(event.service).toBe("imessage")
    expect(event.isGroup).toBe(false)
    expect(event.providerOptedOut).toBe(false)
    expect(event.destinationE164).toBe("+46711111111")
  })

  it("preserves the immediate parent of an inbound inline reply", () => {
    const event = normalizeInbound(
      decodeWebhookPayload({
        ...payload,
        reply_to: { message_handle: "outbound-parent", part_index: 0 }
      }),
      {
        accountId: "account-1",
        lineId: "line-1",
        randomUuid: () => "018e6f65-4d55-7a1b-8df4-4ee15ea1db9f"
      }
    )

    expect(event).toMatchObject({ replyToMessageHandle: "outbound-parent" })
  })

  it("marks group messages and unknown services as ineligible for native interactions", () => {
    const event = normalizeInbound(
      decodeWebhookPayload({ ...payload, group_id: "group-1", service: "carrier-pigeon" }),
      {
        accountId: "account-1",
        lineId: "line-1",
        randomUuid: () => "018e6f65-4d55-7a1b-8df4-4ee15ea1db9f"
      }
    )
    expect(event.service).toBe("unknown")
    expect(event.isGroup).toBe(true)
  })

  it.each([
    ["REGISTERED", "registered"],
    ["PENDING", "pending"],
    ["DECLINED", "declined"],
    ["QUEUED", "queued"],
    ["ACCEPTED", "accepted"],
    ["SENT", "sent"],
    ["DELIVERED", "delivered"],
    ["ERROR", "error"]
  ] as const)("normalizes the documented %s callback", (providerStatus, normalizedStatus) => {
    const event = normalizeStatus(
      decodeWebhookPayload({
        ...payload,
        is_outbound: true,
        status: providerStatus,
        from_number: "+46711111111",
        to_number: "+46700000000"
      }),
      {
        accountId: "account-1",
        lineId: "line-1",
        outboxId: "018e6f65-4d55-7a1b-8df4-4ee15ea1dba0",
        attemptId: "018e6f65-4d55-7a1b-8df4-4ee15ea1dba1",
        correlationId: "018e6f65-4d55-7a1b-8df4-4ee15ea1dba2",
        randomUuid: () => "018e6f65-4d55-7a1b-8df4-4ee15ea1db9f"
      }
    )
    expect(event.status).toBe(normalizedStatus)
    expect(event.destinationE164).toBe("+46700000000")
    expect(event.outboxId).toBe("018e6f65-4d55-7a1b-8df4-4ee15ea1dba0")
    expect(event.attemptId).toBe("018e6f65-4d55-7a1b-8df4-4ee15ea1dba1")
    expect(event.correlationId).toBe("018e6f65-4d55-7a1b-8df4-4ee15ea1dba2")
  })

  it("preserves unrelated hooks and adds only missing Bob hooks", async () => {
    const plan = await planWebhookReconciliation(
      {
        status: "OK",
        webhooks: {
          receive: ["https://other.example/receive"],
          outbound: [],
          call_log: ["https://other.example/calls"],
          globalSecret: "secret"
        }
      },
      {
        receiveUrl: "https://bob.example/webhooks/receive",
        outboundUrl: "https://bob.example/webhooks/outbound",
        globalSecret: "secret"
      }
    )
    expect(plan.additions).toEqual([
      { type: "receive", url: "https://bob.example/webhooks/receive" },
      { type: "outbound", url: "https://bob.example/webhooks/outbound" }
    ])
    expect(plan.state).toBe("changes_required")
  })

  it("does not change hooks when the global secret differs", async () => {
    const plan = await planWebhookReconciliation(
      { status: "OK", webhooks: { receive: [], outbound: [], globalSecret: "wrong" } },
      {
        receiveUrl: "https://bob.example/webhooks/receive",
        outboundUrl: "https://bob.example/webhooks/outbound",
        globalSecret: "right"
      }
    )
    expect(plan.state).toBe("secret_mismatch")
    expect(plan.additions).toEqual([])
  })

  it.each([
    {
      state: "duplicate_hooks",
      webhooks: {
        receive: ["https://bob.example/webhooks/receive", "https://bob.example/webhooks/receive"],
        outbound: []
      }
    },
    {
      state: "changes_required",
      webhooks: { receive: ["https://bob.example/webhooks/receive"], outbound: [] }
    },
    {
      state: "converged",
      webhooks: {
        receive: ["https://bob.example/webhooks/receive"],
        outbound: ["https://bob.example/webhooks/outbound"]
      }
    }
  ] as const)("reports $state as one authoritative state", async ({ state, webhooks }) => {
    const plan = await planWebhookReconciliation(
      { webhooks: { ...webhooks, globalSecret: "secret" } },
      {
        receiveUrl: "https://bob.example/webhooks/receive",
        outboundUrl: "https://bob.example/webhooks/outbound",
        globalSecret: "secret"
      }
    )

    expect(plan.state).toBe(state)
    if (state === "duplicate_hooks") expect(plan.additions).toEqual([])
  })

  it("applies missing hooks and requires the reread to converge", async () => {
    const requests: RequestInit[] = []
    const reads = [
      {
        webhooks: {
          receive: ["https://bob.example/webhooks/receive"],
          outbound: [],
          globalSecret: "secret"
        }
      },
      {
        webhooks: {
          receive: ["https://bob.example/webhooks/receive"],
          outbound: ["https://bob.example/webhooks/outbound"],
          globalSecret: "secret"
        }
      }
    ]
    const client = createAccountClient({
      apiKeyId: "id",
      apiSecretKey: "key",
      fetch: async (_input, init) => {
        requests.push(init ?? {})
        return init?.method === "POST"
          ? Response.json({ status: "OK" })
          : Response.json(reads.shift())
      }
    })

    const plan = await client.reconcile(
      {
        receiveUrl: "https://bob.example/webhooks/receive",
        outboundUrl: "https://bob.example/webhooks/outbound",
        globalSecret: "secret"
      },
      false
    )

    expect(plan.state).toBe("converged")
    expect(requests.map((request) => request.method ?? "GET")).toEqual(["GET", "POST", "GET"])
  })

  it("does not mutate a non-repairable webhook state", async () => {
    const methods: string[] = []
    const client = createAccountClient({
      apiKeyId: "id",
      apiSecretKey: "key",
      fetch: async (_input, init) => {
        methods.push(init?.method ?? "GET")
        return Response.json({
          webhooks: {
            receive: [
              "https://bob.example/webhooks/receive",
              "https://bob.example/webhooks/receive"
            ],
            outbound: [],
            globalSecret: "secret"
          }
        })
      }
    })

    const plan = await client.reconcile(
      {
        receiveUrl: "https://bob.example/webhooks/receive",
        outboundUrl: "https://bob.example/webhooks/outbound",
        globalSecret: "secret"
      },
      false
    )

    expect(plan.state).toBe("duplicate_hooks")
    expect(methods).toEqual(["GET"])
  })

  it("fails apply mode when the provider reread does not converge", async () => {
    const client = createAccountClient({
      apiKeyId: "id",
      apiSecretKey: "key",
      fetch: async (_input, init) =>
        init?.method === "POST"
          ? Response.json({ status: "OK" })
          : Response.json({
              webhooks: {
                receive: ["https://bob.example/webhooks/receive"],
                outbound: [],
                globalSecret: "secret"
              }
            })
    })

    await expect(
      client.reconcile(
        {
          receiveUrl: "https://bob.example/webhooks/receive",
          outboundUrl: "https://bob.example/webhooks/outbound",
          globalSecret: "secret"
        },
        false
      )
    ).rejects.toThrow("Sendblue webhook verification failed")
  })
})
