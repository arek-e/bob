import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import {
  annotateModelUsage,
  currentBobCorrelationId,
  emitHealth,
  flushTelemetry,
  noopSpanProcessor,
  recordDecision,
  telemetryLayer,
  withBobRootSpan,
  withBobSpan
} from "../src/effect.ts"
import { makeCaptureTelemetry } from "../src/testing.ts"

const correlationId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db9f"
const runId = "018e6f65-4d55-7a1b-8df4-4ee15ea1dba0"

describe("Effect telemetry", () => {
  it("records closed conversation steering metadata without message content", async () => {
    const telemetry = makeCaptureTelemetry({
      serviceName: "bob-core-worker",
      serviceVersion: "0123456789abcdef0123456789abcdef01234567",
      deploymentEnvironment: "test"
    })
    const conversationTurnId = "018e6f65-4d55-7a1b-8df4-4ee15ea1dba2"

    await Effect.runPromise(
      withBobSpan(
        {
          name: "bob.run.cancel_request",
          correlationId,
          runId,
          conversationTurnId,
          conversationRevision: 2,
          feature: "assistant"
        },
        recordDecision({
          name: "bob.decision.steering",
          code: "abort_model",
          outcome: "applied",
          conversationRevision: 2
        })
      ).pipe(Effect.provide(telemetry.layer))
    )

    expect(telemetry.finishedSpans()).toEqual([
      expect.objectContaining({
        name: "bob.run.cancel_request",
        attributes: expect.objectContaining({
          "bob.conversation.turn_id": conversationTurnId,
          "bob.conversation.revision": 2
        }),
        events: [
          expect.objectContaining({
            name: "bob.decision.steering",
            attributes: {
              "bob.decision.code": "abort_model",
              "bob.decision.outcome": "applied",
              "bob.conversation.revision": 2
            }
          })
        ]
      })
    ])
  })

  it("starts an explicit Bob root without the current parent", async () => {
    const telemetry = makeCaptureTelemetry({
      serviceName: "bob-core-worker",
      serviceVersion: "0123456789abcdef0123456789abcdef01234567",
      deploymentEnvironment: "test"
    })
    const secondCorrelationId = "018e6f65-4d55-7a1b-8df4-4ee15ea1dba1"

    await Effect.runPromise(
      withBobSpan(
        {
          name: "bob.reminder.clock",
          correlationId,
          feature: "reminders"
        },
        withBobRootSpan(
          {
            name: "bob.reminder.dispatch",
            correlationId: secondCorrelationId,
            feature: "reminders"
          },
          Effect.void
        )
      ).pipe(Effect.provide(telemetry.layer))
    )

    const clock = telemetry.finishedSpans().find((span) => span.name === "bob.reminder.clock")
    const dispatch = telemetry.finishedSpans().find((span) => span.name === "bob.reminder.dispatch")
    expect(dispatch?.parentSpanId).toBeUndefined()
    expect(dispatch?.traceId).not.toBe(clock?.traceId)
    expect(dispatch?.attributes["bob.correlation.id"]).toBe(secondCorrelationId)
  })

  it("records one safe agent and tool trace tree", async () => {
    const telemetry = makeCaptureTelemetry({
      serviceName: "bob-agent",
      serviceVersion: "0123456789abcdef0123456789abcdef01234567",
      deploymentEnvironment: "test"
    })

    const program = withBobSpan(
      {
        name: "bob.agent.run",
        correlationId,
        runId,
        feature: "reminders"
      },
      Effect.gen(function* () {
        expect(yield* currentBobCorrelationId).toBe(correlationId)
        yield* recordDecision({
          name: "bob.decision.toolset",
          code: "reminder_intent",
          outcome: "selected",
          selectedCount: 2,
          toolName: "reminder_create"
        })
        yield* withBobSpan(
          {
            name: "bob.agent.turn",
            correlationId,
            runId,
            feature: "reminders",
            turnIndex: 1,
            turnPhase: "primary"
          },
          Effect.gen(function* () {
            yield* recordDecision({
              name: "bob.decision.loop",
              code: "tool_calls",
              outcome: "selected",
              selectedCount: 1
            })
            yield* withBobSpan(
              {
                name: "bob.model.complete",
                correlationId,
                runId,
                feature: "reminders",
                turnIndex: 1,
                turnPhase: "primary"
              },
              annotateModelUsage({
                provider: "openai-codex",
                model: "gpt-5.6-luna",
                inputTokens: 31,
                outputTokens: 12,
                toolCallCount: 1
              })
            )
            yield* withBobSpan(
              {
                name: "bob.tool.invoke",
                correlationId,
                runId,
                feature: "reminders",
                toolName: "reminder_create",
                toolCallIndex: 1
              },
              Effect.succeed({ ok: true })
            )
          })
        )
      })
    )
    await Effect.runPromise(program.pipe(Effect.provide(telemetry.layer)))
    await Effect.runPromise(telemetry.flush.pipe(Effect.provide(telemetry.layer)))

    const spans = telemetry.finishedSpans()
    expect(spans.map((span) => span.name)).toEqual([
      "bob.model.complete",
      "bob.tool.invoke",
      "bob.agent.turn",
      "bob.agent.run"
    ])
    expect(spans[0]?.parentSpanId).toBe(spans[2]?.spanId)
    expect(spans[1]?.parentSpanId).toBe(spans[2]?.spanId)
    expect(spans[2]?.parentSpanId).toBe(spans[3]?.spanId)
    expect(new Set(spans.map((span) => span.traceId))).toEqual(new Set([spans[0]?.traceId]))
    expect(spans[0]?.attributes).toMatchObject({
      "gen_ai.provider.name": "openai-codex",
      "gen_ai.request.model": "gpt-5.6-luna",
      "gen_ai.usage.input_tokens": 31,
      "gen_ai.usage.output_tokens": 12,
      "bob.tool.call_count": 1
    })
    expect(spans[2]?.events).toContainEqual(
      expect.objectContaining({
        name: "bob.decision.loop",
        attributes: {
          "bob.decision.code": "tool_calls",
          "bob.decision.outcome": "selected",
          "bob.selected.count": 1
        }
      })
    )
    expect(spans[3]?.events).toContainEqual(
      expect.objectContaining({
        name: "bob.decision.toolset",
        attributes: {
          "bob.decision.code": "reminder_intent",
          "bob.decision.outcome": "selected",
          "bob.selected.count": 2,
          "bob.tool.name": "reminder_create"
        }
      })
    )
    expect(
      JSON.stringify(spans, (_key, value) =>
        value !== null && value !== undefined && value.constructor === BigInt
          ? value.toString()
          : value
      )
    ).not.toMatch(/prompt|arguments|result|reasoning|secret|phone/iu)

    await telemetry.shutdown()
    expect(await Effect.runPromise(currentBobCorrelationId)).toBeUndefined()
  })

  it("drops unapproved spans and never exports failure content", async () => {
    const telemetry = makeCaptureTelemetry({
      serviceName: "bob-agent",
      serviceVersion: "0123456789abcdef0123456789abcdef01234567",
      deploymentEnvironment: "test"
    })
    const privateCanary = "private-phone-+46700000000"
    const approved = withBobSpan(
      {
        name: "bob.model.complete",
        correlationId,
        runId,
        feature: "assistant"
      },
      Effect.fail(new Error(privateCanary))
    )
    const unknown = Effect.withSpan(Effect.fail(new Error(privateCanary)), "private.prompt", {
      attributes: { prompt: privateCanary },
      captureStackTrace: false
    })

    await Effect.runPromiseExit(approved.pipe(Effect.provide(telemetry.layer)))
    await Effect.runPromiseExit(unknown.pipe(Effect.provide(telemetry.layer)))

    const spans = telemetry.finishedSpans()
    expect(spans).toHaveLength(1)
    expect(spans[0]).toMatchObject({ name: "bob.model.complete", outcome: "failed" })
    expect(
      JSON.stringify(spans, (_key, value) =>
        value !== null && value !== undefined && value.constructor === BigInt
          ? value.toString()
          : value
      )
    ).not.toContain(privateCanary)
  })

  it("drops an unknown output validation code without dropping the decision", async () => {
    const privateCanary = "private-validation-code-8841"
    const telemetry = makeCaptureTelemetry({
      serviceName: "bob-agent",
      serviceVersion: "0123456789abcdef0123456789abcdef01234567",
      deploymentEnvironment: "test"
    })

    await Effect.runPromise(
      withBobSpan(
        {
          name: "bob.output.validate",
          correlationId,
          runId,
          feature: "assistant"
        },
        Effect.gen(function* () {
          const span = yield* Effect.currentSpan
          const now = yield* Effect.clockWith((clock) => clock.currentTimeNanos)
          span.event("bob.decision.output", now, {
            "bob.decision.code": "repair_required",
            "bob.decision.outcome": "selected",
            "bob.output.validation_code": privateCanary
          })
        })
      ).pipe(Effect.provide(telemetry.layer))
    )

    expect(telemetry.finishedSpans()[0]?.events).toContainEqual(
      expect.objectContaining({
        name: "bob.decision.output",
        attributes: {
          "bob.decision.code": "repair_required",
          "bob.decision.outcome": "selected"
        }
      })
    )
    expect(
      JSON.stringify(telemetry.finishedSpans(), (_key, value) =>
        value !== null && value !== undefined && value.constructor === BigInt
          ? value.toString()
          : value
      )
    ).not.toContain(privateCanary)
  })

  it("keeps health telemetry failures outside the application result", async () => {
    const layer = telemetryLayer({
      processor: {
        onEnd: () => undefined,
        forceFlush: Effect.void,
        shutdown: Effect.void
      },
      writeHealth: () => {
        throw new Error("collector unavailable")
      }
    })
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* emitHealth({
          type: "provider_auth",
          correlationId,
          status: "configured",
          code: "configured"
        })
        return "durable-result"
      }).pipe(Effect.provide(layer))
    )

    expect(result).toBe("durable-result")
  })

  it("provides a reusable no-op processor for fail-open runtime composition", async () => {
    const layer = telemetryLayer({ processor: noopSpanProcessor, writeHealth: () => undefined })

    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          yield* withBobSpan(
            { name: "bob.inbound.accept", correlationId, feature: "assistant" },
            Effect.void
          )
          yield* flushTelemetry
          return "workflow-result"
        }).pipe(Effect.provide(layer))
      )
    ).resolves.toBe("workflow-result")
  })

  it("keeps span processor failures outside the application result", async () => {
    const layer = telemetryLayer({
      processor: {
        onEnd: () => {
          throw new Error("collector unavailable")
        },
        forceFlush: Effect.void,
        shutdown: Effect.void
      },
      writeHealth: () => undefined
    })

    await expect(
      Effect.runPromise(
        withBobSpan(
          {
            name: "bob.inbound.persist",
            correlationId,
            feature: "assistant"
          },
          Effect.succeed("durable-result")
        ).pipe(Effect.provide(layer))
      )
    ).resolves.toBe("durable-result")
  })

  it("drops invalid model metadata without changing the application result", async () => {
    const telemetry = makeCaptureTelemetry({
      serviceName: "bob-agent",
      serviceVersion: "0123456789abcdef0123456789abcdef01234567",
      deploymentEnvironment: "test"
    })
    const privateCanary = "private-model-+46700000000"

    const result = await Effect.runPromise(
      withBobSpan(
        {
          name: "bob.model.complete",
          correlationId,
          runId,
          feature: "assistant"
        },
        Effect.gen(function* () {
          yield* annotateModelUsage({
            provider: "openai-codex",
            model: privateCanary,
            inputTokens: 11,
            outputTokens: 7,
            toolCallCount: 0
          })
          return "model-result"
        })
      ).pipe(Effect.provide(telemetry.layer))
    )

    expect(result).toBe("model-result")
    expect(telemetry.finishedSpans()).toEqual([
      expect.objectContaining({
        name: "bob.model.complete",
        outcome: "completed",
        attributes: expect.objectContaining({
          "gen_ai.provider.name": "openai-codex",
          "gen_ai.usage.input_tokens": 11,
          "gen_ai.usage.output_tokens": 7,
          "bob.tool.call_count": 0
        })
      })
    ])
    expect(
      JSON.stringify(telemetry.finishedSpans(), (_key, value) =>
        value !== null && value !== undefined && value.constructor === BigInt
          ? value.toString()
          : value
      )
    ).not.toContain(privateCanary)
  })

  it("skips an invalid span without changing the application result", async () => {
    const telemetry = makeCaptureTelemetry({
      serviceName: "bob-agent",
      serviceVersion: "0123456789abcdef0123456789abcdef01234567",
      deploymentEnvironment: "test"
    })

    await expect(
      Effect.runPromise(
        withBobSpan(
          {
            name: "bob.agent.run",
            correlationId: "private-invalid-correlation",
            feature: "assistant"
          },
          withBobSpan(
            {
              name: "bob.agent.turn",
              correlationId,
              feature: "assistant",
              turnIndex: 0,
              turnPhase: "primary"
            },
            Effect.succeed("agent-result")
          )
        ).pipe(Effect.provide(telemetry.layer))
      )
    ).resolves.toBe("agent-result")
    expect(telemetry.finishedSpans()).toEqual([])
  })

  it("skips an invalid decision without changing the application result", async () => {
    const telemetry = makeCaptureTelemetry({
      serviceName: "bob-agent",
      serviceVersion: "0123456789abcdef0123456789abcdef01234567",
      deploymentEnvironment: "test"
    })
    const privateCanary = "private-tool-+46700000000"

    const result = await Effect.runPromise(
      withBobSpan(
        {
          name: "bob.agent.run",
          correlationId,
          runId,
          feature: "assistant"
        },
        Effect.gen(function* () {
          yield* recordDecision({
            name: "bob.decision.toolset",
            code: "allowed",
            outcome: "selected",
            toolName: privateCanary
          })
          return "agent-result"
        })
      ).pipe(Effect.provide(telemetry.layer))
    )

    expect(result).toBe("agent-result")
    expect(telemetry.finishedSpans()).toEqual([
      expect.objectContaining({ name: "bob.agent.run", outcome: "completed", events: [] })
    ])
  })

  it("keeps processor flush and shutdown failures outside the application result", async () => {
    const layer = telemetryLayer({
      processor: {
        onEnd: () => undefined,
        forceFlush: Effect.die("collector flush failed"),
        shutdown: Effect.die("collector shutdown failed")
      },
      writeHealth: () => undefined
    })

    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          yield* flushTelemetry
          return "durable-result"
        }).pipe(Effect.provide(layer))
      )
    ).resolves.toBe("durable-result")
  })

  it("normalizes approved spans and removes unapproved identity fields", async () => {
    const telemetry = makeCaptureTelemetry({
      serviceName: "bob-agent",
      serviceVersion: "0123456789abcdef0123456789abcdef01234567",
      deploymentEnvironment: "test"
    })
    const privateCanary = "private name +46700000000"
    const effect = Effect.withSpan(Effect.void, "bob.tool.invoke", {
      kind: "internal",
      attributes: {
        "bob.correlation.id": correlationId,
        "bob.feature": "assistant",
        "bob.workflow": "tool_execution",
        "bob.tool.name": privateCanary,
        "bob.tool.call_id": privateCanary,
        "gen_ai.request.model": privateCanary
      }
    })

    await Effect.runPromise(effect.pipe(Effect.provide(telemetry.layer)))

    expect(telemetry.finishedSpans()).toEqual([
      expect.objectContaining({
        name: "bob.tool.invoke",
        kind: "client",
        attributes: {
          "bob.correlation.id": correlationId,
          "bob.feature": "assistant",
          "bob.workflow": "tool_execution"
        }
      })
    ])
    expect(
      JSON.stringify(telemetry.finishedSpans(), (_key, value) =>
        value !== null && value !== undefined && value.constructor === BigInt
          ? value.toString()
          : value
      )
    ).not.toContain(privateCanary)
  })
})
