import type { AgentRunRequest } from "@bob/agent-types/run"
import type { CoreDatabase } from "@bob/db-types"
import type { DataProtection } from "@bob/policy-types/data-protection"
import type { OwnerDataKeyStoreAdapter } from "@bob/policy-types/owner-data-key"
import type { ToolCommandAdapter } from "@bob/tools-types/adapter"
import type { ToolResult } from "@bob/tools-types/tools"

import { makeCaptureTelemetry, withBobSpan } from "@bob/observability"
import { makeToolAdapterRegistry } from "@bob/tools-service/registry"
import { makeCapabilityCatalogue } from "@bob/tools-types/catalogue"
import { Context, Effect, Option } from "effect"
import { describe, expect, it, vi } from "vitest"

import { makeToolExecutor } from "../src/tool-executor.ts"

const runId = "018e6f65-4d55-7a1b-8df4-4ee15ea1dba0"
const ownerId = "018e6f65-4d55-7a1b-8df4-4ee15ea1dba1"
const correlationId = "018e6f65-4d55-7a1b-8df4-4ee15ea1dba2"
const messageId = "018e6f65-4d55-7a1b-8df4-4ee15ea1dba3"

const capability = {
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

class ToolDependency extends Context.Service<ToolDependency, { readonly value: string }>()(
  "test/ToolDependency"
) {}

function scriptedDatabase(results: unknown[]): CoreDatabase {
  const next = () => Effect.sync(() => results.shift())
  const builder = () => {
    const query = new Proxy(
      {},
      {
        get: (_target, property) => {
          if (
            property === "limit" ||
            property === "onConflictDoNothing" ||
            property === "returning"
          ) {
            return next
          }
          if (property === "getSQL") return () => query
          return () => query
        }
      }
    )
    return query
  }
  const databaseTarget = {}
  // SAFETY: The Proxy supplies the database query operations exercised by this test.
  const database = databaseTarget as CoreDatabase
  return new Proxy(database, {
    get: (_target, property) =>
      property === "select" || property === "insert" || property === "update" ? builder : undefined
  })
}

const protection: DataProtection = {
  createWrappedDataKey: async () => {
    throw new Error("unused")
  },
  unwrapDataKey: async () => {
    throw new Error("unused")
  },
  encryptText: async (_key, value) => ({ ciphertext: value, iv: "iv" }),
  decryptText: async (_key, value) => value.ciphertext,
  encryptBytes: async (_key, value) => ({ ciphertext: value, iv: "iv" }),
  decryptBytes: async (_key, value) => value.ciphertext,
  hashLookup: async (value) => value,
  contentHash: async (value) => value,
  contentHashBytes: async (value) => String(value.byteLength)
}
// SAFETY: Encryption is stubbed in this test, so no CryptoKey operation reads this value.
const testCryptoKey = {} as CryptoKey
const ownerDataKeys: OwnerDataKeyStoreAdapter = {
  load: async () => ({ key: testCryptoKey, version: 1 }),
  ensure: async () => ({ key: testCryptoKey, version: 1 })
}

describe("Effect-native durable Tool execution", () => {
  it.each([
    [[{ id: "tool-row" }], { ok: true, code: "read", message: "Inherited." }],
    [
      [],
      {
        ok: false,
        code: "tool_in_progress",
        message: "This tool call lost its durable execution claim."
      }
    ]
  ] as const)(
    "inherits Effect services, protects claim settlement, and ends the complete Tool span tree",
    async (settlement, expected) => {
      const request: AgentRunRequest = {
        protocolVersion: 1,
        runId,
        ownerId,
        correlationId,
        sourceMessageId: messageId,
        localTime: "2026-08-17T10:00:00.000Z",
        timeZone: "Europe/Stockholm",
        userText: "Read it.",
        contextItems: [],
        allowedTools: ["test_read"],
        limits: {
          maxTurns: 2,
          maxToolCalls: 1,
          maxDurationMs: 30_000,
          maxResponseCharacters: 500
        }
      }
      const pending = {
        id: "tool-row",
        runId,
        toolCallId: "call-1",
        idempotencyKey: "key-1",
        ownerId,
        toolName: "test_read",
        commandHash: await import("../src/tool-executor.ts").then(({ toolCommandHash }) =>
          toolCommandHash({
            runId,
            ownerId,
            toolCallId: "call-1",
            idempotencyKey: "key-1",
            name: "test_read",
            arguments: {}
          })
        ),
        argumentsJson: "{}",
        resultJson: null,
        status: "pending",
        claimToken: null,
        claimedAt: null,
        claimExpiresAt: null,
        attemptNumber: 0,
        createdAt: "2026-08-17T10:00:00.000Z",
        completedAt: null
      }
      const run = {
        ownerId,
        conversationTurnId: null,
        conversationTurnRevision: null,
        targetMessageId: messageId
      }
      const database = scriptedDatabase([
        [run],
        [],
        [],
        [pending],
        [run],
        [{ id: pending.id }],
        [
          {
            run: {
              userId: ownerId,
              status: "executing",
              claimExpiresAt: "2026-08-17T10:02:00.000Z",
              inputSnapshotJson: JSON.stringify({
                ciphertext: JSON.stringify(request),
                iv: "iv",
                keyVersion: 1
              })
            },
            inbound: { channelId: "channel-1", messageId }
          }
        ],
        settlement
      ])
      const adapter: ToolCommandAdapter = {
        capabilityId: "test-tools",
        names: ["test_read"],
        execute: () =>
          Effect.gen(function* () {
            const dependency = yield* Effect.serviceOption(ToolDependency)
            return {
              ok: true,
              code: "read",
              message: Option.getOrElse(dependency, () => ({ value: "missing" })).value
            } satisfies ToolResult
          })
      }
      const catalogue = makeCapabilityCatalogue("test", [capability])
      const executor = makeToolExecutor(
        database,
        protection,
        makeToolAdapterRegistry(catalogue, [adapter]),
        {
          now: () => new Date("2026-08-17T10:01:00.000Z"),
          randomUuid: () => "018e6f65-4d55-7a1b-8df4-4ee15ea1dbaf",
          ownerDataKeys
        }
      )
      const telemetry = makeCaptureTelemetry({
        serviceName: "bob-tool-executor-test",
        serviceVersion: "0123456789abcdef0123456789abcdef01234567",
        deploymentEnvironment: "test"
      })

      const result = await Effect.runPromise(
        withBobSpan(
          {
            name: "bob.tool.execute",
            correlationId,
            feature: "assistant",
            runId,
            toolName: "test_read"
          },
          executor.execute({
            runId,
            ownerId,
            toolCallId: "call-1",
            idempotencyKey: "key-1",
            name: "test_read",
            arguments: {}
          })
        ).pipe(
          Effect.provideService(ToolDependency, { value: "Inherited." }),
          Effect.provide(telemetry.layer)
        )
      )

      expect(result).toEqual(expected)
      const spans = telemetry.finishedSpans()
      const execute = spans.find((span) => span.name === "bob.tool.execute")
      const claim = spans.find((span) => span.name === "bob.tool.claim")
      const domain = spans.find((span) => span.name === "bob.tool.domain")
      expect(claim?.parentSpanId).toBe(execute?.spanId)
      expect(domain?.parentSpanId).toBe(claim?.spanId)
      expect([execute, claim, domain].every((span) => span?.outcome === "completed")).toBe(true)
      expect(
        [execute, claim, domain].every(
          (span) => span !== undefined && span.endTimeUnixNano >= span.startTimeUnixNano
        )
      ).toBe(true)
    }
  )

  it("denies a Tool command owned by a different Owner before domain execution", async () => {
    const execute = vi.fn(() =>
      Effect.succeed({ ok: true, code: "read", message: "Unexpected." } satisfies ToolResult)
    )
    const catalogue = makeCapabilityCatalogue("test", [capability])
    const executor = makeToolExecutor(
      scriptedDatabase([
        [
          {
            ownerId: "018e6f65-4d55-7a1b-8df4-4ee15ea1dbff",
            conversationTurnId: null,
            conversationTurnRevision: null,
            targetMessageId: messageId
          }
        ]
      ]),
      protection,
      makeToolAdapterRegistry(catalogue, [
        { capabilityId: "test-tools", names: ["test_read"], execute }
      ]),
      { ownerDataKeys }
    )

    const result = await Effect.runPromise(
      executor.execute({
        runId,
        ownerId,
        toolCallId: "call-1",
        idempotencyKey: "key-1",
        name: "test_read",
        arguments: {}
      })
    )

    expect(result.code).toBe("policy_denied")
    expect(execute).not.toHaveBeenCalled()
  })
})
