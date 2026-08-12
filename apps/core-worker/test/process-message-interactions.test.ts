import { captureEvents } from "@bob/observability/testing"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { CoreBindings } from "../src/bindings.ts"
import type { CoreComposition } from "../src/composition.ts"

import { processInbound } from "../src/process-inbound.ts"

const eventId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db90"
const messageHandle = "inbound-provider-handle"

afterEach(() => {
  vi.unstubAllGlobals()
})

function interactionComposition(
  createOutbox: (input: unknown) => Promise<string>,
  message: { readonly service: "imessage" | "sms" | "rcs"; readonly isGroup: boolean } = {
    service: "imessage",
    isGroup: false
  }
) {
  return {
    config: {
      UI_BASE_URL: "https://bob.example.invalid",
      SENDBLUE_EGRESS_URL: "https://egress.example.invalid",
      EGRESS_CALLER_SECRET: "e".repeat(64)
    },
    services: {
      events: captureEvents(),
      conversations: {
        claimInbound: vi.fn(async () => ({
          eventId,
          ownerId: "018e6f65-4d55-7a1b-8df4-4ee15ea1db91",
          channelId: "018e6f65-4d55-7a1b-8df4-4ee15ea1db92",
          messageId: "018e6f65-4d55-7a1b-8df4-4ee15ea1db93",
          text: "HELP",
          providerMessageHandle: messageHandle,
          service: message.service,
          isGroup: message.isGroup,
          number: "+46700000000",
          fromNumber: "+46711111111",
          correlationId: "018e6f65-4d55-7a1b-8df4-4ee15ea1db94"
        })),
        claimReaction: vi.fn(async () => true),
        completeInbound: vi.fn(async () => undefined)
      },
      training: { stopActiveForSafety: vi.fn() },
      journal: { createHandoff: vi.fn() },
      reminders: { applyBoundReply: vi.fn() },
      delivery: {
        createOutbox,
        markEnqueued: vi.fn(async () => undefined)
      }
    }
  } as unknown as CoreComposition
}

const bindings = {
  OUTBOUND_QUEUE: { send: vi.fn(async () => undefined) }
} as unknown as CoreBindings

describe("inbound native message interactions", () => {
  it("confirms before the action and stops typing after the response is ready", async () => {
    const order: string[] = []
    const interactionBodies: unknown[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { action: string }
        interactionBodies.push(body)
        order.push(body.action)
        return Response.json({ accepted: true })
      })
    )
    const createOutbox = vi.fn(async () => {
      order.push("action")
      return "018e6f65-4d55-7a1b-8df4-4ee15ea1db95"
    })
    const composition = interactionComposition(createOutbox)

    await processInbound(eventId, bindings, composition)

    expect(order).toEqual(["start", "action", "stop"])
    expect(interactionBodies).toEqual([
      {
        action: "start",
        number: "+46700000000",
        fromNumber: "+46711111111",
        messageHandle,
        react: true,
        maxDurationMs: 90_000
      },
      {
        action: "stop",
        number: "+46700000000",
        fromNumber: "+46711111111"
      }
    ])
    expect(createOutbox).toHaveBeenCalledWith(
      expect.objectContaining({ replyToMessageHandle: messageHandle })
    )
  })

  it("stops typing when the durable action fails", async () => {
    const actions: string[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        actions.push((JSON.parse(String(init?.body)) as { action: string }).action)
        return Response.json({ accepted: true })
      })
    )
    const composition = interactionComposition(async () => {
      throw new Error("outbox unavailable")
    })

    await expect(processInbound(eventId, bindings, composition)).rejects.toThrow()
    expect(actions).toEqual(["start", "stop"])
  })

  it.each([
    ["sms", false],
    ["rcs", false],
    ["imessage", true]
  ] as const)("skips native interactions for %s with group=%s", async (service, isGroup) => {
    const request = vi.fn<typeof fetch>()
    vi.stubGlobal("fetch", request)
    const createOutbox = vi.fn(async () => "018e6f65-4d55-7a1b-8df4-4ee15ea1db95")
    const composition = interactionComposition(createOutbox, { service, isGroup })

    await processInbound(eventId, bindings, composition)

    expect(request).not.toHaveBeenCalled()
    expect(createOutbox).toHaveBeenCalledWith(
      expect.not.objectContaining({ replyToMessageHandle: expect.anything() })
    )
  })
})
