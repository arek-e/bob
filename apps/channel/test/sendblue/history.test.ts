import { it } from "@effect/vitest"
import { Effect, Fiber, Redacted } from "effect"
import { TestClock } from "effect/testing"
import { expect, vi } from "vitest"

import { SendblueProvider, sendblueProviderTestLayer } from "../../src/sendblue/provider.ts"

const inbound = {
  accountEmail: "owner@example.invalid",
  content: "PING",
  is_outbound: false,
  status: "RECEIVED",
  error_code: null,
  error_message: null,
  error_reason: null,
  message_handle: "handle-1",
  date_sent: "2026-08-13T10:30:00.000Z",
  date_updated: "2026-08-13T10:30:00.000Z",
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

const withProvider = <A, E>(
  fetch: typeof globalThis.fetch,
  use: (provider: SendblueProvider["Service"]) => Effect.Effect<A, E>,
  timeoutMs = 10_000
) =>
  Effect.flatMap(SendblueProvider, use).pipe(
    Effect.provide(
      sendblueProviderTestLayer(
        {
          apiKeyId: "key-id",
          apiSecretKey: Redacted.make("secret-key"),
          baseUrl: "https://sendblue.example.test",
          timeoutMs
        },
        fetch
      )
    )
  )

it.effect("lists inbound messages for one bounded window", () => {
  const request = vi.fn<typeof fetch>(async () =>
    Response.json({ status: "OK", data: [inbound], pagination: { total: 1 } })
  )
  return Effect.gen(function* () {
    const result = yield* withProvider(request, (provider) =>
      provider.listInbound({
        sendblueNumber: "+46711111111",
        since: new Date("2026-08-13T10:20:00.000Z"),
        until: new Date("2026-08-13T10:31:00.000Z")
      })
    )
    expect(result).toEqual([inbound])
    const url = new URL(String(request.mock.calls[0]?.[0]))
    expect(Object.fromEntries(url.searchParams)).toEqual({
      is_outbound: "false",
      limit: "100",
      sendblue_number: "+46711111111",
      sent_at_gte: "2026-08-13T10:20:00.000Z",
      sent_at_lte: "2026-08-13T10:31:00.000Z"
    })
  })
})

it.effect("checks that the configured line remains assigned", () => {
  const request = vi.fn<typeof fetch>(async () => Response.json({ numbers: ["+46711111111"] }))
  return Effect.gen(function* () {
    const result = yield* withProvider(request, (provider) => provider.hasLine("+46711111111"))
    expect(result).toBe(true)
    expect(String(request.mock.calls[0]?.[0])).toBe("https://sendblue.example.test/api/lines")
  })
})

it.effect("lists outbound messages in one bounded window", () => {
  const outbound = { ...inbound, is_outbound: true, status: "DELIVERED" }
  const request = vi.fn<typeof fetch>(async () =>
    Response.json({ status: "OK", data: [outbound], pagination: { total: 1 } })
  )
  return Effect.gen(function* () {
    const result = yield* withProvider(request, (provider) =>
      provider.listOutbound({
        sendblueNumber: "+46711111111",
        since: new Date("2026-08-13T10:20:00.000Z"),
        until: new Date("2026-08-13T10:40:00.000Z")
      })
    )
    expect(result).toEqual([outbound])
    const url = new URL(String(request.mock.calls[0]?.[0]))
    expect(url.searchParams.get("is_outbound")).toBe("true")
  })
})

it.effect("interrupts a history request at the configured timeout", () => {
  const request = vi.fn(
    async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
      })
  )
  return Effect.gen(function* () {
    const fiber = yield* withProvider(
      request,
      (provider) => provider.hasLine("+46711111111").pipe(Effect.result),
      1_000
    ).pipe(Effect.forkChild)
    yield* TestClock.adjust(1_000)
    const result = yield* Fiber.join(fiber)
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") expect(result.failure._tag).toBe("SendblueTimeoutError")
    expect(request.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal)
  })
})
