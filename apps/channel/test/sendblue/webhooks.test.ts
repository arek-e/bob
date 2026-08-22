import { it } from "@effect/vitest"
import { Effect, Redacted, Schema } from "effect"
import { describe, expect, vi } from "vitest"

import {
  SendblueProvider,
  SendblueWebhookList,
  planWebhookReconciliation,
  requiredWebhooksFromStatusCallback,
  sendblueProviderTestLayer,
  timingSafeEqual
} from "../../src/sendblue/provider.ts"
import {
  decodeWebhookPayload,
  normalizeInbound,
  normalizeStatus
} from "../../src/sendblue/webhooks.ts"

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
} as const

const decode = (input: typeof Schema.Json.Type) => Effect.runSync(decodeWebhookPayload(input))

const required = {
  receiveUrl: "https://bob.example/webhooks/receive",
  outboundUrl: "https://bob.example/webhooks/outbound",
  globalSecret: "secret"
}

function plan(input: typeof Schema.Json.Type, secretMatches = true) {
  return planWebhookReconciliation(
    Schema.decodeUnknownSync(SendblueWebhookList)(input),
    required,
    secretMatches
  )
}

function reconcile(fetch: typeof globalThis.fetch, checkOnly = false) {
  return Effect.flatMap(SendblueProvider, (provider) =>
    provider.reconcileWebhooks(required, checkOnly)
  ).pipe(
    Effect.provide(
      sendblueProviderTestLayer(
        {
          apiKeyId: "id",
          apiSecretKey: Redacted.make("key")
        },
        fetch
      )
    )
  )
}

describe("Sendblue webhook normalization", () => {
  it.effect("compares the shared secret", () =>
    Effect.gen(function* () {
      expect(yield* timingSafeEqual("right", "right")).toBe(true)
      expect(yield* timingSafeEqual("wrong", "right")).toBe(false)
    })
  )

  it("normalizes only the required message fields", () => {
    const event = normalizeInbound(decode(payload), {
      accountId: "account-1",
      lineId: "line-1",
      randomUuid: () => "018e6f65-4d55-7a1b-8df4-4ee15ea1db9f"
    })
    expect(event).toMatchObject({
      text: "PING",
      messageHandle: "handle-1",
      service: "imessage",
      isGroup: false,
      providerOptedOut: false,
      destinationE164: "+46711111111"
    })
  })

  it("normalizes an image-only inbound message without retaining its provider URL", () => {
    const event = normalizeInbound(
      decode({ ...payload, content: "", media_url: "https://media.example.test/image.png" }),
      {
        accountId: "account-1",
        lineId: "line-1",
        randomUuid: () => "018e6f65-4d55-7a1b-8df4-4ee15ea1db9f"
      }
    )
    expect(event).toMatchObject({ text: "", attachmentCount: 1 })
    expect(JSON.stringify(event)).not.toContain("media.example.test")
  })

  it("preserves the immediate parent of an inbound inline reply", () => {
    const event = normalizeInbound(
      decode({ ...payload, reply_to: { message_handle: "outbound-parent", part_index: 0 } }),
      {
        accountId: "account-1",
        lineId: "line-1",
        randomUuid: () => "018e6f65-4d55-7a1b-8df4-4ee15ea1db9f"
      }
    )
    expect(event).toMatchObject({ replyToMessageHandle: "outbound-parent" })
  })

  it("marks group messages and unknown transports", () => {
    const event = normalizeInbound(
      decode({ ...payload, group_id: "group-1", service: "carrier-pigeon" }),
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
      decode({
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
  })
})

describe("Sendblue webhook reconciliation", () => {
  it("derives the receive hook from the public status callback URL", () => {
    expect(
      requiredWebhooksFromStatusCallback(
        "https://bob-ingress.example/webhooks/outbound?ignored=true",
        "secret"
      )
    ).toEqual({
      receiveUrl: "https://bob-ingress.example/webhooks/receive",
      outboundUrl: "https://bob-ingress.example/webhooks/outbound",
      globalSecret: "secret"
    })
  })

  it("rejects a status callback URL that does not identify the outbound route", () => {
    expect(() =>
      requiredWebhooksFromStatusCallback("https://bob-ingress.example/status", "secret")
    ).toThrow("SENDBLUE_STATUS_CALLBACK_URL must end with /outbound")
  })

  it("preserves unrelated hooks and adds only missing Bob hooks", () => {
    const result = plan({
      status: "OK",
      webhooks: {
        receive: ["https://other.example/receive"],
        outbound: [],
        call_log: ["https://other.example/calls"],
        globalSecret: "secret"
      }
    })
    expect(result.additions).toEqual([
      { type: "receive", url: required.receiveUrl },
      { type: "outbound", url: required.outboundUrl }
    ])
    expect(result.state).toBe("changes_required")
  })

  it("does not change hooks when the global secret differs", () => {
    const result = plan(
      { status: "OK", webhooks: { receive: [], outbound: [], globalSecret: "wrong" } },
      false
    )
    expect(result.state).toBe("secret_mismatch")
    expect(result.additions).toEqual([])
  })

  it.each([
    {
      state: "duplicate_hooks",
      webhooks: {
        receive: [required.receiveUrl, required.receiveUrl],
        outbound: []
      }
    },
    {
      state: "changes_required",
      webhooks: { receive: [required.receiveUrl], outbound: [] }
    },
    {
      state: "converged",
      webhooks: { receive: [required.receiveUrl], outbound: [required.outboundUrl] }
    }
  ] as const)("reports $state as one authoritative state", ({ state, webhooks }) => {
    expect(plan({ webhooks: { ...webhooks, globalSecret: "secret" } }).state).toBe(state)
  })

  it.effect("applies missing hooks and requires the reread to converge", () => {
    const requests: RequestInit[] = []
    const reads = [
      { webhooks: { receive: [required.receiveUrl], outbound: [], globalSecret: "secret" } },
      {
        webhooks: {
          receive: [required.receiveUrl],
          outbound: [required.outboundUrl],
          globalSecret: "secret"
        }
      }
    ]
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(init ?? {})
      return init?.method === "POST"
        ? Response.json({ status: "OK" })
        : Response.json(reads.shift())
    })
    return Effect.gen(function* () {
      const result = yield* reconcile(fetch)
      expect(result.state).toBe("converged")
      expect(requests.map((request) => request.method ?? "GET")).toEqual(["GET", "POST", "GET"])
    })
  })

  it.effect("does not mutate a non-repairable webhook state", () => {
    const methods: string[] = []
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      methods.push(init?.method ?? "GET")
      return Response.json({
        webhooks: {
          receive: [required.receiveUrl, required.receiveUrl],
          outbound: [],
          globalSecret: "secret"
        }
      })
    })
    return Effect.gen(function* () {
      const result = yield* reconcile(fetch)
      expect(result.state).toBe("duplicate_hooks")
      expect(methods).toEqual(["GET"])
    })
  })

  it.effect("fails when the provider does not converge after mutation", () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "POST"
        ? Response.json({ status: "OK" })
        : Response.json({
            webhooks: { receive: [required.receiveUrl], outbound: [], globalSecret: "secret" }
          })
    )
    return Effect.gen(function* () {
      const result = yield* reconcile(fetch).pipe(Effect.result)
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") expect(result.failure._tag).toBe("SendblueVerificationError")
    })
  })
})
