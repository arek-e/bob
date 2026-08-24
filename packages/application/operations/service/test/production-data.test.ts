import type { CoreDatabase } from "@bob/db-types"

import {
  createProductionDataInspector,
  type ProductionDataDatabase,
  productionDataInspectorLayer
} from "@bob/operations-service/production-data/inspector"
import {
  type ProductionDataInspectorAdapter,
  parseProductionDataQuery,
  ProductionDataInspector,
  PRODUCTION_DATA_MAX_LIMIT
} from "@bob/operations-types/production-data"
import { Effect } from "effect"
import { describe, expect, it, vi } from "vitest"

function fakeDatabase(rows: readonly (readonly object[])[]) {
  let index = 0
  const execute = vi.fn(
    (_statement: Parameters<CoreDatabase["execute"]>[0], _resultType: "objects") =>
      Effect.succeed(rows[index++] ?? [])
  )
  const database: ProductionDataDatabase = { execute }
  return { database, execute }
}

describe("production data inspection", () => {
  it("normalizes a bounded query window", () => {
    const query = parseProductionDataQuery(
      { to: "2026-08-23T12:00:00.000Z", limit: "7" },
      new Date("2026-08-23T12:00:00.000Z")
    )

    expect(query).toEqual({
      from: "2026-08-16T12:00:00.000Z",
      to: "2026-08-23T12:00:00.000Z",
      limit: 7
    })
  })

  it.each([
    [{ limit: "0" }, "limit"],
    [{ limit: String(PRODUCTION_DATA_MAX_LIMIT + 1) }, "limit"],
    [{ from: "2026-01-01", to: "2026-03-01" }, "window"],
    [{ from: "not-a-date" }, "from"]
  ])("rejects unsafe query input %j", (input, _label) => {
    expect(() => parseProductionDataQuery(input)).toThrow()
  })

  it("returns metadata without selecting private payload columns", async () => {
    const { database, execute } = fakeDatabase([
      [{ total: 3 }],
      [{ total: 1 }],
      [{ total: 2 }],
      [{ total: 4 }],
      [{ key: "inbound", count: 2 }],
      [{ key: "processed", count: 2 }],
      [{ key: "completed", count: 2 }],
      [{ key: "accepted", count: 1 }],
      [{ key: "succeeded", count: 4 }],
      [
        {
          ownerRef: "abc123",
          messages: 3,
          inboundMessages: 2,
          outboundMessages: 1,
          agentRuns: 2,
          completedRuns: 2,
          failedRuns: 0,
          toolCalls: 4
        }
      ]
    ])
    const inspector = createProductionDataInspector(database)
    const result = await inspector.summary({
      from: "2026-08-23T00:00:00.000Z",
      to: "2026-08-24T00:00:00.000Z",
      limit: 50
    })

    expect(result.totalMessages).toBe(3)
    expect(result.owners[0]?.ownerRef).toBe("abc123")
    expect(result).not.toHaveProperty("text")
    expect(result).not.toHaveProperty("argumentsJson")
    expect(execute).toHaveBeenCalledTimes(10)
  })

  it("maps workflow metadata and omits encrypted operation payloads", async () => {
    const { database } = fakeDatabase([
      [
        {
          id: "inbound-1",
          messageId: "message-1",
          correlationId: "correlation-1",
          service: "sms",
          isGroup: false,
          attachmentCount: 0,
          recoveryCount: 0,
          enqueuedAt: null,
          claimedAt: "2026-08-23T12:00:01.000Z",
          processedAt: "2026-08-23T12:00:02.000Z",
          deadLetteredAt: null,
          createdAt: "2026-08-23T12:00:00.000Z"
        }
      ],
      [
        {
          id: "run-1",
          correlationId: "correlation-1",
          originType: "conversation_turn",
          status: "completed",
          model: "test-model",
          executionPoolId: "core-v1",
          claimedAt: null,
          completedAt: "2026-08-23T12:00:03.000Z",
          finalizationCompletedAt: "2026-08-23T12:00:04.000Z",
          createdAt: "2026-08-23T12:00:02.000Z"
        }
      ],
      [],
      [],
      [
        {
          id: "tool-1",
          runId: "run-1",
          toolName: "settings.read",
          status: "completed",
          attemptNumber: 1,
          claimedAt: null,
          completedAt: "2026-08-23T12:00:03.000Z",
          createdAt: "2026-08-23T12:00:02.000Z"
        }
      ]
    ])
    const result = await createProductionDataInspector(database).workflow("correlation-1", 50)

    expect(result.inboundEvents).toHaveLength(1)
    expect(result.agentRuns[0]?.status).toBe("completed")
    expect(result.toolCalls[0]?.toolName).toBe("settings.read")
    expect(result).not.toHaveProperty("inputSnapshotJson")
    expect(result).not.toHaveProperty("payloadCiphertext")
  })

  it("provides the inspector through its Effect service", async () => {
    const adapter: ProductionDataInspectorAdapter = {
      summary: vi.fn(async () => ({
        from: "2026-08-23T00:00:00.000Z",
        to: "2026-08-24T00:00:00.000Z",
        totalMessages: 0,
        totalOwners: 0,
        totalAgentRuns: 0,
        totalToolCalls: 0,
        messageDirections: [],
        inboundEventStates: [],
        agentRunStates: [],
        deliveryStates: [],
        toolCallStates: [],
        owners: []
      })),
      workflow: vi.fn(async (correlationId) => ({
        correlationId,
        inboundEvents: [],
        agentRuns: [],
        outboxMessages: [],
        deliveryAttempts: [],
        toolCalls: []
      }))
    }
    const result = await Effect.runPromise(
      ProductionDataInspector.pipe(
        Effect.flatMap((inspector) =>
          inspector.summary({
            from: "2026-08-23T00:00:00.000Z",
            to: "2026-08-24T00:00:00.000Z",
            limit: 50
          })
        )
      ).pipe(Effect.provide(productionDataInspectorLayer(adapter)))
    )

    expect(result.totalMessages).toBe(0)
  })
})
