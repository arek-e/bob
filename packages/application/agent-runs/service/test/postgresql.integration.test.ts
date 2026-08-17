import type { AgentRunRequest, AgentRunResult } from "@bob/agent-types/run"

import { AgentRunConflict, AgentRunNotFound } from "@bob/agent-runs-types/agent-runs"
import { AgentRunAuthorityLost } from "@bob/agent-runs-types/worker-gateway"
import {
  PostgresqlDatabase,
  type PostgresqlDatabaseService,
  postgresqlDatabaseLayer
} from "@bob/db-service/postgresql"
import { agentRunOutbox } from "@bob/db-service/schema/conversations"
import { transitionalDeploymentProfile } from "@bob/deployment-profile-types/profiles"
import { createDataProtection } from "@bob/policy-service/data-protection"
import { makeOwnerDataKeyStore } from "@bob/policy-service/owner-data-key"
import { eq } from "drizzle-orm"
import { Effect, ManagedRuntime } from "effect"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { makeAgentRuns } from "../src/agent-runs.ts"
import { makeAgentRunGateway } from "../src/worker-gateway.ts"

const databaseUrl = process.env.TEST_DATABASE_URL
const integration = databaseUrl === undefined ? describe.skip : describe
const migrationsFolder = fileURLToPath(
  new URL("../../../../db/service/migrations", import.meta.url)
)

integration("PostgreSQL Agent Runs", () => {
  let dispose: (() => Promise<void>) | undefined
  let database: PostgresqlDatabaseService

  beforeAll(async () => {
    if (databaseUrl === undefined) throw new Error("TEST_DATABASE_URL is required")
    const runtime = ManagedRuntime.make(postgresqlDatabaseLayer(databaseUrl, { migrationsFolder }))
    dispose = () => runtime.dispose()
    database = await runtime.runPromise(PostgresqlDatabase)
    await runtime.runPromise(database.migrate)
  })

  afterAll(async () => {
    await dispose?.()
  })

  it("fences attempts and emits a durable continuation", async () => {
    const ownerId = crypto.randomUUID()
    const runId = crypto.randomUUID()
    const correlationId = crypto.randomUUID()
    const occurrenceId = crypto.randomUUID()
    const request: AgentRunRequest = {
      protocolVersion: 1,
      deploymentProfileId: transitionalDeploymentProfile.profileId,
      capabilityCatalogueGeneration: transitionalDeploymentProfile.generation,
      runId,
      ownerId,
      correlationId,
      localTime: "2026-08-18T12:00:00.000Z",
      timeZone: "Europe/Stockholm",
      userText: "Summarize my current work.",
      contextItems: [],
      allowedTools: [],
      limits: {
        maxTurns: 2,
        maxToolCalls: 1,
        maxDurationMs: 30_000,
        maxResponseCharacters: 500
      }
    }
    const result: AgentRunResult = {
      protocolVersion: 1,
      runId,
      correlationId,
      status: "completed",
      responseText: "Your work is ready.",
      model: "gpt-5.6-luna",
      durationMs: 25,
      inputTokens: 12,
      outputTokens: 9,
      toolCalls: 0
    }
    const protection = createDataProtection({ 1: "11".repeat(32) }, 1, "22".repeat(32))
    const ownerDataKeys = makeOwnerDataKeyStore(database.applicationStorage, protection, {
      defaultTimeZone: "UTC"
    })
    await ownerDataKeys.ensure(ownerId)
    const runs = makeAgentRuns(database.applicationStorage, protection, { ownerDataKeys })
    const gateway = makeAgentRunGateway(database.applicationStorage, protection, {
      ownerDataKeys,
      randomUuid: () => crypto.randomUUID()
    })
    const submission = {
      idempotencyKey: `postgres-agent-run-${runId}`,
      origin: { type: "scheduled" as const, occurrenceId },
      request,
      execution: {
        jobProtocolVersion: 1,
        coreGatewayProtocolVersion: 1,
        checkpointLoopVersion: 1,
        deploymentProfileId: transitionalDeploymentProfile.profileId,
        capabilityCatalogueGeneration: transitionalDeploymentProfile.generation,
        executionPoolId: "core-v1"
      }
    }

    await expect(Effect.runPromise(runs.submit(submission))).resolves.toMatchObject({
      runId,
      state: "accepted"
    })
    await expect(Effect.runPromise(runs.submit(submission))).resolves.toMatchObject({
      runId,
      state: "already_accepted"
    })
    await expect(
      Effect.runPromise(
        runs.submit({
          ...submission,
          request: { ...request, userText: "Use the same key for different work." }
        })
      )
    ).rejects.toBeInstanceOf(AgentRunConflict)
    await expect(
      Effect.runPromise(runs.inspect({ runId, ownerId: crypto.randomUUID() }))
    ).rejects.toBeInstanceOf(AgentRunNotFound)

    const acquired = await Effect.runPromise(
      gateway.acquire({
        job: { wireVersion: 1, runId, dispatchGeneration: 1, executionPoolId: "core-v1" },
        workerId: "worker-a",
        leaseMs: 60_000
      })
    )
    if (acquired.state !== "acquired")
      throw new Error(`Agent Run was not acquired: ${JSON.stringify(acquired)}`)
    expect(acquired.request).toEqual(request)

    await expect(
      Effect.runPromise(
        gateway.renew({
          authority: { ...acquired.authority, attemptFence: acquired.authority.attemptFence + 1 },
          leaseMs: 60_000
        })
      )
    ).rejects.toBeInstanceOf(AgentRunAuthorityLost)

    await expect(
      Effect.runPromise(
        gateway.acquire({
          job: { wireVersion: 1, runId, dispatchGeneration: 1, executionPoolId: "core-v1" },
          workerId: "worker-b",
          leaseMs: 60_000
        })
      )
    ).resolves.toMatchObject({ state: "not_eligible", reason: "already_claimed" })

    await expect(
      Effect.runPromise(gateway.recordOutcome({ authority: acquired.authority, result }))
    ).resolves.toBe("accepted")
    await expect(
      Effect.runPromise(gateway.recordOutcome({ authority: acquired.authority, result }))
    ).resolves.toBe("duplicate")

    await expect(Effect.runPromise(runs.inspect({ runId, ownerId }))).resolves.toMatchObject({
      state: "awaiting_finalization",
      attemptCount: 1
    })
    const continuation = await Effect.runPromise(
      database.applicationStorage
        .select({ kind: agentRunOutbox.kind, generation: agentRunOutbox.generation })
        .from(agentRunOutbox)
        .where(eq(agentRunOutbox.runId, runId))
    )
    expect(continuation).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "dispatch", generation: 1 }),
        expect.objectContaining({ kind: "continuation", generation: 1 })
      ])
    )

    const cancelledRunId = crypto.randomUUID()
    const cancelledCorrelationId = crypto.randomUUID()
    const cancelledRequest = {
      ...request,
      runId: cancelledRunId,
      correlationId: cancelledCorrelationId
    }
    await Effect.runPromise(
      runs.submit({
        ...submission,
        idempotencyKey: `postgres-agent-run-${cancelledRunId}`,
        origin: { type: "scheduled", occurrenceId: crypto.randomUUID() },
        request: cancelledRequest
      })
    )
    const cancellationAttempt = await Effect.runPromise(
      gateway.acquire({
        job: {
          wireVersion: 1,
          runId: cancelledRunId,
          dispatchGeneration: 1,
          executionPoolId: "core-v1"
        },
        workerId: "worker-a",
        leaseMs: 60_000
      })
    )
    if (cancellationAttempt.state !== "acquired")
      throw new Error("Cancellation Agent Run was not acquired")
    const cancellation = {
      runId: cancelledRunId,
      ownerId,
      idempotencyKey: `cancel-${cancelledRunId}`,
      reason: "owner_request" as const
    }
    const firstCancellation = await Effect.runPromise(runs.cancel(cancellation))
    const replayedCancellation = await Effect.runPromise(runs.cancel(cancellation))
    expect(firstCancellation).toMatchObject({ state: "requested", controlRevision: 1 })
    expect(replayedCancellation).toEqual(firstCancellation)
    await expect(
      Effect.runPromise(gateway.readControl(cancellationAttempt.authority))
    ).resolves.toMatchObject({ revision: 1, cancellationRequested: true })
    await expect(
      Effect.runPromise(
        gateway.recordOutcome({
          authority: cancellationAttempt.authority,
          result: {
            protocolVersion: 1,
            runId: cancelledRunId,
            correlationId: cancelledCorrelationId,
            status: "cancelled",
            errorCode: "cancelled",
            model: "gpt-5.6-luna",
            durationMs: 25,
            inputTokens: 12,
            outputTokens: 0,
            toolCalls: 0
          }
        })
      )
    ).resolves.toBe("accepted")
  })
})
