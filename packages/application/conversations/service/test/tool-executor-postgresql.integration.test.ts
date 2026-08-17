import type { AgentRunRequest } from "@bob/agent-types/run"
import type { DataProtection } from "@bob/policy-types/data-protection"
import type { OwnerDataKeyStoreAdapter } from "@bob/policy-types/owner-data-key"
import type { ToolCommandAdapter } from "@bob/tools-types/adapter"

import { PostgresqlDatabase, postgresqlDatabaseLayer } from "@bob/db-service/postgresql"
import { makeToolAdapterRegistry } from "@bob/tools-service/registry"
import { makeCapabilityCatalogue } from "@bob/tools-types/catalogue"
import { sql } from "drizzle-orm"
import { Deferred, Effect, Fiber, ManagedRuntime } from "effect"
import { fileURLToPath } from "node:url"
import { afterAll, describe, expect, it } from "vitest"

import { makeToolExecutor } from "../src/tool-executor.ts"

const databaseUrl = process.env.TEST_DATABASE_URL
const integration = databaseUrl === undefined ? describe.skip : describe
const migrationsFolder = fileURLToPath(
  new URL("../../../../db/service/migrations", import.meta.url)
)

const protection: DataProtection = {
  createWrappedDataKey: async () => {
    throw new Error("unused")
  },
  unwrapDataKey: async () => {
    throw new Error("unused")
  },
  encryptText: async (_key, value) => ({ ciphertext: value, iv: "iv" }),
  decryptText: async (_key, value) => value.ciphertext,
  hashLookup: async (value) => value,
  contentHash: async (value) => value
}
const ownerDataKeys: OwnerDataKeyStoreAdapter = {
  load: async () => ({ key: {} as CryptoKey, version: 1 }),
  ensure: async () => ({ key: {} as CryptoKey, version: 1 })
}

integration("PostgreSQL durable Tool execution", () => {
  let dispose: (() => Promise<void>) | undefined

  afterAll(async () => {
    await dispose?.()
  })

  it("does not let an old claimant settle after its claim token changes", async () => {
    if (databaseUrl === undefined) throw new Error("TEST_DATABASE_URL is required")
    const runtime = ManagedRuntime.make(
      postgresqlDatabaseLayer(databaseUrl, { migrationsFolder, maximumConnections: 4 })
    )
    dispose = () => runtime.dispose()
    const database = await runtime.runPromise(PostgresqlDatabase)
    await runtime.runPromise(database.migrate)

    const ownerId = crypto.randomUUID()
    const runId = crypto.randomUUID()
    const inboundEventId = crypto.randomUUID()
    const messageId = crypto.randomUUID()
    const idempotencyKey = crypto.randomUUID()
    const correlationId = crypto.randomUUID()
    const now = new Date("2026-08-17T10:00:00.000Z")
    const request: AgentRunRequest = {
      protocolVersion: 1,
      runId,
      ownerId,
      correlationId,
      sourceMessageId: messageId,
      localTime: now.toISOString(),
      timeZone: "Europe/Stockholm",
      userText: "Read it.",
      contextItems: [],
      allowedTools: ["postgres_read"],
      limits: {
        maxTurns: 2,
        maxToolCalls: 1,
        maxDurationMs: 30_000,
        maxResponseCharacters: 500
      }
    }
    const inputSnapshotJson = JSON.stringify({
      ciphertext: JSON.stringify(request),
      iv: "iv",
      keyVersion: 1
    })

    await runtime.runPromise(
      Effect.all(
        [
          database.applicationStorage.execute(sql`
            INSERT INTO inbound_events (
              id, user_id, channel_id, message_id, account_id, line_id,
              provider_message_handle, correlation_id, created_at
            ) VALUES (
              ${inboundEventId}, ${ownerId}, 'channel', ${messageId}, 'account', 'line',
              ${inboundEventId}, ${correlationId}, ${now.toISOString()}
            )
          `),
          database.applicationStorage.execute(sql`
            INSERT INTO agent_runs (
              id, user_id, inbound_event_id, target_message_id, correlation_id,
              input_snapshot_json, input_hash, status, model, claim_expires_at, created_at
            ) VALUES (
              ${runId}, ${ownerId}, ${inboundEventId}, ${messageId}, ${correlationId},
              ${inputSnapshotJson}, 'test-hash', 'executing', 'test-model',
              '2026-08-17T11:00:00.000Z', ${now.toISOString()}
            )
          `)
        ],
        { concurrency: 1 }
      )
    )

    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const capability = {
          id: "postgres-tools",
          version: 1,
          feature: "assistant",
          tools: [
            {
              kind: "model",
              name: "postgres_read",
              description: "Read test data.",
              inputSchema: { type: "object", properties: {}, additionalProperties: false },
              readOnly: true
            }
          ]
        } as const
        const adapter: ToolCommandAdapter = {
          capabilityId: "postgres-tools",
          names: ["postgres_read"],
          execute: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined)
              yield* Deferred.await(release)
              return { ok: true, code: "read", message: "Done." }
            })
        }
        const catalogue = makeCapabilityCatalogue("postgres-test", [capability])
        const executor = makeToolExecutor(
          database.applicationStorage,
          protection,
          makeToolAdapterRegistry(catalogue, [adapter]),
          { now: () => now, ownerDataKeys }
        )
        const fiber = yield* Effect.forkChild(
          executor.execute({
            runId,
            ownerId,
            toolCallId: "call-1",
            idempotencyKey,
            name: "postgres_read",
            arguments: {}
          })
        )
        yield* Deferred.await(entered)
        yield* database.applicationStorage.execute(sql`
          UPDATE tool_calls
          SET claim_token = 'replacement-claim'
          WHERE idempotency_key = ${idempotencyKey}
        `)
        yield* Deferred.succeed(release, undefined)
        return yield* Fiber.join(fiber)
      })
    )

    expect(result).toMatchObject({ ok: false, code: "tool_in_progress" })
    const [row] = await runtime.runPromise(
      database.applicationStorage.execute<{
        readonly claim_token: string
        readonly result_json: string | null
      }>(sql`
        SELECT claim_token, result_json
        FROM tool_calls
        WHERE idempotency_key = ${idempotencyKey}
      `)
    )
    expect(row).toEqual({ claim_token: "replacement-claim", result_json: null })

    await runtime.runPromise(
      Effect.all(
        [
          database.applicationStorage.execute(
            sql`DELETE FROM tool_calls WHERE idempotency_key = ${idempotencyKey}`
          ),
          database.applicationStorage.execute(sql`DELETE FROM agent_runs WHERE id = ${runId}`),
          database.applicationStorage.execute(
            sql`DELETE FROM inbound_events WHERE id = ${inboundEventId}`
          )
        ],
        { concurrency: 1 }
      )
    )
  }, 30_000)
})
