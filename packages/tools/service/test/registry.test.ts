import type { ToolCommandAdapterContext } from "@bob/tools-types/adapter"

import { makeCaptureTelemetry, withBobSpan } from "@bob/observability"
import { ToolAdapterError } from "@bob/tools-types/adapter"
import { makeCapabilityCatalogue } from "@bob/tools-types/catalogue"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import { executeRegisteredTool, makeToolAdapterRegistry } from "../src/registry.ts"

const correlationId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db91"
const runId = "018e6f65-4d55-7a1b-8df4-4ee15ea1dba0"
const ownerId = "018e6f65-4d55-7a1b-8df4-4ee15ea1dba1"
const module = {
  id: "test-tools",
  version: 1,
  feature: "assistant",
  tools: [
    {
      kind: "model",
      name: "test_read",
      description: "Read test data.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      readOnly: true
    }
  ]
} as const
const catalogue = makeCapabilityCatalogue("test", [module])
const context: ToolCommandAdapterContext = {
  command: {
    runId,
    ownerId,
    toolCallId: "call-1",
    idempotencyKey: "key-1",
    name: "test_read",
    arguments: {}
  },
  run: {
    correlationId,
    userText: "Read it.",
    localTime: "2026-08-17T10:00:00.000+02:00",
    timeZone: "Europe/Stockholm",
    channelId: "channel-1",
    messageId: "message-1"
  }
}

function telemetry() {
  return makeCaptureTelemetry({
    serviceName: "bob-tools-test",
    serviceVersion: "0123456789abcdef0123456789abcdef01234567",
    deploymentEnvironment: "test"
  })
}

describe("Tool registry telemetry", () => {
  it("ends a successful domain span below the execute span", async () => {
    const capture = telemetry()
    const registry = makeToolAdapterRegistry(catalogue, [
      {
        capabilityId: "test-tools",
        names: ["test_read"],
        execute: () => Effect.succeed({ ok: true, code: "read", message: "Read." })
      }
    ])
    const domain = executeRegisteredTool(registry, context)
    expect(domain).toBeDefined()

    await Effect.runPromise(
      withBobSpan(
        {
          name: "bob.tool.execute",
          correlationId,
          feature: "assistant",
          runId,
          toolName: "test_read"
        },
        domain!
      ).pipe(Effect.provide(capture.layer))
    )

    const spans = capture.finishedSpans()
    const execute = spans.find((span) => span.name === "bob.tool.execute")
    const toolDomain = spans.find((span) => span.name === "bob.tool.domain")
    expect(toolDomain?.parentSpanId).toBe(execute?.spanId)
    expect(toolDomain?.outcome).toBe("completed")
    expect(toolDomain?.endTimeUnixNano).toBeGreaterThanOrEqual(toolDomain!.startTimeUnixNano)
  })

  it("ends a failed domain span when its Adapter fails", async () => {
    const capture = telemetry()
    const registry = makeToolAdapterRegistry(catalogue, [
      {
        capabilityId: "test-tools",
        names: ["test_read"],
        execute: () =>
          Effect.fail(
            new ToolAdapterError({
              capabilityId: "test-tools",
              operation: "read",
              cause: "test failure"
            })
          )
      }
    ])
    const domain = executeRegisteredTool(registry, context)
    expect(domain).toBeDefined()

    await Effect.runPromiseExit(domain!.pipe(Effect.provide(capture.layer)))

    const toolDomain = capture.finishedSpans().find((span) => span.name === "bob.tool.domain")
    expect(toolDomain?.outcome).toBe("failed")
    expect(toolDomain?.endTimeUnixNano).toBeGreaterThanOrEqual(toolDomain!.startTimeUnixNano)
  })
})
