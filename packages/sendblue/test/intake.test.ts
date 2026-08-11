import { describe, expect, it, vi } from "vitest"

import { acceptSendblueWebhook } from "../src/webhooks.ts"

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

const policy = {
  signingSecret: "signing-secret",
  accountId: "account",
  lineId: "line",
  fromNumber: "+46711111111",
  allowedUserNumber: "+46700000000"
}

describe("Sendblue webhook intake", () => {
  it("authenticates before it reads the request body", async () => {
    const readPayload = vi.fn(async () => payload)

    await expect(
      acceptSendblueWebhook({
        pathname: "/webhooks/receive",
        suppliedSecret: "wrong",
        readPayload,
        policy
      })
    ).rejects.toMatchObject({ code: "unauthorized", status: 401 })
    expect(readPayload).not.toHaveBeenCalled()
  })

  it("normalizes one allowlisted inbound message", async () => {
    const accepted = await acceptSendblueWebhook({
      pathname: "/webhooks/receive",
      suppliedSecret: policy.signingSecret,
      readPayload: async () => payload,
      policy
    })

    expect(accepted).toMatchObject({
      kind: "inbound",
      event: {
        accountId: "account",
        lineId: "line",
        senderE164: policy.allowedUserNumber,
        destinationE164: policy.fromNumber,
        text: "PING"
      }
    })
  })

  it("rejects an inbound message from another sender", async () => {
    await expect(
      acceptSendblueWebhook({
        pathname: "/webhooks/receive",
        suppliedSecret: policy.signingSecret,
        readPayload: async () => ({ ...payload, from_number: "+46799999999" }),
        policy
      })
    ).rejects.toMatchObject({ code: "not_allowed", status: 403 })
  })

  it("validates status callback correlation metadata", async () => {
    await expect(
      acceptSendblueWebhook({
        pathname: "/webhooks/outbound",
        suppliedSecret: policy.signingSecret,
        readPayload: async () => ({
          ...payload,
          is_outbound: true,
          status: "ACCEPTED",
          from_number: policy.fromNumber,
          to_number: policy.allowedUserNumber
        }),
        policy,
        statusMetadata: { outboxId: "not-a-uuid" }
      })
    ).rejects.toMatchObject({ code: "invalid_webhook", status: 400 })
  })
})
