import { it } from "@effect/vitest"
import { Effect, Redacted, Schema } from "effect"
import { expect, vi } from "vitest"

import {
  SendblueProvider,
  sendblueProviderTestLayer,
  type SendblueProviderOptions
} from "../../src/sendblue/provider.ts"

const claim = {
  outboxId: "018e6f65-4d55-7a1b-8df4-4ee15ea1db9f",
  attemptId: "018e6f65-4d55-7a1b-8df4-4ee15ea1dba0",
  number: "+46700000000",
  fromNumber: "+46711111111",
  smsSafeText: "Reminder test",
  correlationId: "018e6f65-4d55-7a1b-8df4-4ee15ea1dba1",
  claimedAt: "2026-08-11T10:00:00.000Z"
} as const

const options = (overrides: Partial<SendblueProviderOptions> = {}): SendblueProviderOptions => ({
  apiKeyId: "id",
  apiSecretKey: Redacted.make("secret"),
  ...overrides
})

function decodeRequestBody(body: BodyInit | null | undefined): typeof Schema.Json.Type {
  if (Schema.is(Schema.String)(body)) {
    return Schema.decodeUnknownSync(Schema.Json)(JSON.parse(body))
  }
  if (body instanceof Uint8Array) {
    return Schema.decodeUnknownSync(Schema.Json)(JSON.parse(new TextDecoder().decode(body)))
  }
  throw new TypeError("Expected a text request body")
}

const withProvider = <A, E>(
  fetch: typeof globalThis.fetch,
  use: (provider: SendblueProvider["Service"]) => Effect.Effect<A, E>,
  overrides?: Partial<SendblueProviderOptions>
) =>
  Effect.flatMap(SendblueProvider, use).pipe(
    Effect.provide(sendblueProviderTestLayer(options(overrides), fetch))
  )

it.effect("returns uncertain when a dispatched request loses its response", () => {
  const request = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("network"))
  return Effect.gen(function* () {
    const result = yield* withProvider(request, (provider) => provider.sendMessage(claim))
    expect(result).toEqual({ state: "uncertain", code: "network" })
    expect(request).toHaveBeenCalledOnce()
  })
})

it.effect("returns accepted only with a provider handle", () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json({ message_handle: "provider-1", status: "QUEUED" }))
  return Effect.gen(function* () {
    const result = yield* withProvider(request, (provider) => provider.sendMessage(claim))
    expect(result).toEqual({ state: "accepted", providerMessageHandle: "provider-1" })
  })
})

it.effect.each([408, 429, 500])("returns uncertain for HTTP %s", (status) => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status }))
  return Effect.gen(function* () {
    const result = yield* withProvider(request, (provider) =>
      provider.sendMessage({ ...claim, replyToMessageHandle: "inbound-1" })
    )
    expect(result).toEqual({ state: "uncertain", code: `http_${status}` })
    expect(request).toHaveBeenCalledOnce()
  })
})

it.effect("returns failed for a definitive client rejection", () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 400 }))
  return Effect.gen(function* () {
    const result = yield* withProvider(request, (provider) => provider.sendMessage(claim))
    expect(result).toEqual({ state: "failed", code: "http_400" })
  })
})

it.effect("validates provider status", () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json({ message_handle: "provider-1", status: "DELIVERED" }))
  return Effect.gen(function* () {
    const result = yield* withProvider(request, (provider) => provider.getStatus("provider-1"))
    expect(result).toEqual({ message_handle: "provider-1", status: "DELIVERED" })
    expect(request.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal)
  })
})

it.effect("sends a reaction with provider fields", () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }))
  return Effect.gen(function* () {
    const result = yield* withProvider(request, (provider) =>
      provider.sendReaction({
        fromNumber: "+46711111111",
        messageHandle: "inbound-1",
        reaction: "like"
      })
    )
    expect(result).toEqual({ state: "accepted" })
    expect(decodeRequestBody(request.mock.calls[0]?.[1]?.body)).toEqual({
      from_number: "+46711111111",
      message_handle: "inbound-1",
      reaction: "like"
    })
  })
})

it.effect.each([
  { status: 400, state: "failed" },
  { status: 408, state: "uncertain" },
  { status: 429, state: "uncertain" },
  { status: 500, state: "uncertain" }
] as const)("classifies interaction HTTP $status as $state", ({ status, state }) => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status }))
  return Effect.gen(function* () {
    const result = yield* withProvider(request, (provider) =>
      provider.sendReaction({
        fromNumber: "+46711111111",
        messageHandle: "inbound-1",
        reaction: "like"
      })
    )
    expect(result).toEqual({ state, code: `http_${status}` })
  })
})

it.effect("starts and stops the typing indicator", () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }))
  return Effect.gen(function* () {
    yield* withProvider(request, (provider) =>
      Effect.all(
        [
          provider.sendTypingIndicator({
            number: "+46700000000",
            fromNumber: "+46711111111",
            state: "start",
            maxDurationMs: 90_000
          }),
          provider.sendTypingIndicator({
            number: "+46700000000",
            fromNumber: "+46711111111",
            state: "stop"
          })
        ],
        { concurrency: 1 }
      )
    )
    expect(request.mock.calls.map((call) => decodeRequestBody(call[1]?.body))).toEqual([
      {
        number: "+46700000000",
        from_number: "+46711111111",
        state: "start",
        max_duration_ms: 90_000
      },
      {
        number: "+46700000000",
        from_number: "+46711111111",
        state: "stop"
      }
    ])
  })
})

it.effect("falls back after a safe inline reply rejection", () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(null, { status: 400 }))
    .mockResolvedValueOnce(Response.json({ message_handle: "provider-2", status: "QUEUED" }))
  return Effect.gen(function* () {
    const result = yield* withProvider(request, (provider) =>
      provider.sendMessage({ ...claim, replyToMessageHandle: "inbound-1" })
    )
    expect(result).toEqual({ state: "accepted", providerMessageHandle: "provider-2" })
    const bodies = request.mock.calls.map((call) => decodeRequestBody(call[1]?.body))
    expect(bodies[0]).toEqual(
      expect.objectContaining({ reply_to: { message_handle: "inbound-1" } })
    )
    expect(bodies[1]).not.toHaveProperty("reply_to")
  })
})
