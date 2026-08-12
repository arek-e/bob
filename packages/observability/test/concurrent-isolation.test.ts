import { Deferred, Effect } from "effect"
import { describe, expect, it } from "vitest"

import { currentBobCorrelationId, withBobSpan } from "../src/effect.ts"
import { externalParentFromTraceparent, injectCurrentTraceparent } from "../src/propagation.ts"
import { makeCaptureTelemetry } from "../src/testing.ts"

const first = {
  correlationId: "018e6f65-4d55-7a1b-8df4-4ee15ea1db9f",
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
  parentSpanId: "00f067aa0ba902b7"
} as const

const second = {
  correlationId: "018e6f65-4d55-7a1b-8df4-4ee15ea1dba1",
  traceId: "7be91f3577b34da6a3ce929d0e0e9124",
  parentSpanId: "10f067aa0ba902b8"
} as const

function traceparent(input: typeof first | typeof second): string {
  return `00-${input.traceId}-${input.parentSpanId}-01`
}

describe("Effect trace isolation", () => {
  it("keeps concurrent external roots and correlation IDs fiber-local", async () => {
    const telemetry = makeCaptureTelemetry({
      serviceName: "bob-agent",
      serviceVersion: "0123456789abcdef0123456789abcdef01234567",
      deploymentEnvironment: "test"
    })

    const observations = await Effect.runPromise(
      Effect.gen(function* () {
        const firstStarted = yield* Deferred.make<void>()
        const secondStarted = yield* Deferred.make<void>()

        const root = (
          input: typeof first | typeof second,
          ownStarted: Deferred.Deferred<void>,
          otherStarted: Deferred.Deferred<void>
        ) =>
          withBobSpan(
            {
              name: "bob.agent.run",
              correlationId: input.correlationId,
              feature: "assistant"
            },
            Effect.gen(function* () {
              yield* Deferred.succeed(ownStarted, undefined)
              yield* Deferred.await(otherStarted)

              return yield* withBobSpan(
                {
                  name: "bob.agent.turn",
                  correlationId: input.correlationId,
                  feature: "assistant",
                  turnIndex: 0,
                  turnPhase: "primary"
                },
                Effect.gen(function* () {
                  const correlationId = yield* currentBobCorrelationId
                  const headers = yield* injectCurrentTraceparent()
                  return { correlationId, traceparent: headers.get("traceparent") }
                })
              )
            })
          ).pipe(Effect.withParentSpan(externalParentFromTraceparent(traceparent(input))!))

        return yield* Effect.all(
          [root(first, firstStarted, secondStarted), root(second, secondStarted, firstStarted)],
          { concurrency: "unbounded" }
        )
      }).pipe(Effect.provide(telemetry.layer))
    )

    const spans = telemetry.finishedSpans()
    expect(spans).toHaveLength(4)

    for (const [index, input] of [first, second].entries()) {
      const ownSpans = spans.filter(
        (span) => span.attributes["bob.correlation.id"] === input.correlationId
      )
      const root = ownSpans.find((span) => span.name === "bob.agent.run")
      const child = ownSpans.find((span) => span.name === "bob.agent.turn")

      expect(ownSpans).toHaveLength(2)
      expect(new Set(ownSpans.map((span) => span.traceId))).toEqual(new Set([input.traceId]))
      expect(root?.parentSpanId).toBe(input.parentSpanId)
      expect(child?.parentSpanId).toBe(root?.spanId)
      expect(observations[index]).toEqual({
        correlationId: input.correlationId,
        traceparent: `00-${input.traceId}-${child?.spanId}-01`
      })
    }
  })
})
