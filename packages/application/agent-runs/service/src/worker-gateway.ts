import type {
  AcquireAgentRun,
  AgentRunAttemptAuthority,
  AgentRunGatewayError,
  AgentRunGatewayService,
  AppendAgentRunCheckpoint,
  RecordAgentRunOutcome,
  RenewAgentRunLease
} from "@bob/agent-runs-types/worker-gateway"
import type { CoreDatabase } from "@bob/db-types"
import type { DataProtection } from "@bob/policy-types/data-protection"
import type { OwnerDataKeyStoreAdapter } from "@bob/policy-types/owner-data-key"

import {
  AgentRunAuthorityLost,
  AgentRunCheckpointConflict,
  AgentRunGateway,
  AgentRunGatewayUnavailable
} from "@bob/agent-runs-types/worker-gateway"
import { AgentRunOperation, AgentRunRequest, AgentRunResult } from "@bob/agent-types/run"
import {
  agentRunAttempts,
  agentRunOperations,
  agentRunOutbox,
  agentRuns,
  conversationTurns
} from "@bob/db-service/schema/conversations"
import { allInTransaction } from "@bob/db-types"
import { makeOwnerDataKeyStore } from "@bob/policy-service/owner-data-key"
import { and, asc, eq, sql } from "drizzle-orm"
import { Effect, Layer, Schema } from "effect"

const StoredEnvelope = Schema.Struct({
  ciphertext: Schema.String,
  iv: Schema.String,
  keyVersion: Schema.Number
})

interface AcquiredRow extends Record<string, unknown> {
  readonly run_id: string
  readonly owner_id: string
  readonly input_snapshot_json: string
  readonly attempt_id: string
  readonly attempt_fence: number
  readonly control_revision: number
  readonly lease_expires_at: string
}

const databaseNow = sql.raw(
  `to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`
)

function unavailable(operation: string, cause: unknown) {
  return new AgentRunGatewayUnavailable({ operation, cause })
}

function preserveGatewayError(operation: string, cause: unknown): AgentRunGatewayError {
  if (cause instanceof AgentRunAuthorityLost || cause instanceof AgentRunGatewayUnavailable) {
    return cause
  }
  return unavailable(operation, cause)
}

export function makeAgentRunGateway(
  database: CoreDatabase,
  protection: DataProtection,
  options: {
    readonly randomUuid?: () => string
    readonly ownerDataKeys?: OwnerDataKeyStoreAdapter
  } = {}
): AgentRunGatewayService {
  const randomUuid = options.randomUuid ?? (() => crypto.randomUUID())
  const ownerDataKeys =
    options.ownerDataKeys ?? makeOwnerDataKeyStore(database, protection, { defaultTimeZone: "UTC" })

  async function loadRequest(ownerId: string, envelopeJson: string) {
    const envelope = Schema.decodeUnknownSync(StoredEnvelope)(JSON.parse(envelopeJson))
    const owner = await ownerDataKeys.load(ownerId)
    return Schema.decodeUnknownSync(AgentRunRequest)(
      JSON.parse(
        await protection.decryptText(owner.key, {
          ciphertext: envelope.ciphertext,
          iv: envelope.iv
        })
      )
    )
  }

  async function loadCheckpoints(runId: string, ownerId: string) {
    const rows = await Effect.runPromise(
      database
        .select()
        .from(agentRunOperations)
        .where(eq(agentRunOperations.runId, runId))
        .orderBy(asc(agentRunOperations.sequence))
    )
    const owner = await ownerDataKeys.load(ownerId)
    return Promise.all(
      rows.map(async (row) =>
        Schema.decodeUnknownSync(AgentRunOperation)({
          protocolVersion: 1,
          loopVersion: row.loopVersion,
          runId: row.runId,
          sequence: row.sequence,
          kind: row.kind,
          payload: Schema.decodeUnknownSync(Schema.Json)(
            JSON.parse(
              await protection.decryptText(owner.key, {
                ciphertext: row.payloadCiphertext,
                iv: row.payloadIv
              })
            )
          )
        })
      )
    )
  }

  async function acquire(input: AcquireAgentRun) {
    const attemptId = randomUuid()
    const rows = await Effect.runPromise(
      database.execute<AcquiredRow>(
        sql`
        WITH candidate AS (
          SELECT id, active_attempt_fence + 1 AS next_fence
          FROM agent_runs
          WHERE id = ${input.job.runId}
            AND dispatch_generation = ${input.job.dispatchGeneration}
            AND execution_pool_id = ${input.job.executionPoolId}
            AND cancellation_requested_at IS NULL
            AND (
              status IN ('accepted', 'queued', 'retry_wait')
              OR (
                status IN ('running', 'executing')
                AND claim_expires_at IS NOT NULL
                AND claim_expires_at::timestamptz < clock_timestamp()
              )
            )
          FOR UPDATE
        ), updated AS (
          UPDATE agent_runs AS run
          SET status = 'running',
              claimed_at = ${databaseNow},
              claim_expires_at = to_char(
                clock_timestamp() + (${input.leaseMs} * interval '1 millisecond'),
                'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
              ),
              active_attempt_id = ${attemptId},
              active_attempt_fence = candidate.next_fence
          FROM candidate
          WHERE run.id = candidate.id
          RETURNING run.id, run.user_id, run.input_snapshot_json, run.active_attempt_fence,
            run.control_revision, run.claim_expires_at
        ), inserted_attempt AS (
          INSERT INTO agent_run_attempts (
            id, run_id, attempt_number, fence, worker_id, lease_expires_at, status, started_at
          )
          SELECT ${attemptId}, updated.id,
            COALESCE((SELECT MAX(attempt_number) + 1 FROM agent_run_attempts WHERE run_id = updated.id), 1),
            updated.active_attempt_fence, ${input.workerId}, updated.claim_expires_at, 'running', ${databaseNow}
          FROM updated
          RETURNING id, run_id, fence
        )
        SELECT updated.id AS run_id,
          updated.user_id AS owner_id,
          updated.input_snapshot_json,
          inserted_attempt.id AS attempt_id,
          inserted_attempt.fence AS attempt_fence,
          updated.control_revision,
          updated.claim_expires_at AS lease_expires_at
        FROM updated
        INNER JOIN inserted_attempt ON inserted_attempt.run_id = updated.id
      `,
        "objects"
      )
    )
    const acquired = rows[0]
    if (acquired === undefined) {
      const [run] = await Effect.runPromise(
        database
          .select({
            status: agentRuns.status,
            dispatchGeneration: agentRuns.dispatchGeneration,
            executionPoolId: agentRuns.executionPoolId,
            cancellationRequestedAt: agentRuns.cancellationRequestedAt,
            claimExpiresAt: agentRuns.claimExpiresAt
          })
          .from(agentRuns)
          .where(eq(agentRuns.id, input.job.runId))
          .limit(1)
      )
      if (run === undefined || terminalStatus(run.status)) {
        return { state: "not_eligible" as const, reason: "terminal" as const }
      }
      if (run.executionPoolId !== input.job.executionPoolId) {
        return { state: "not_eligible" as const, reason: "pool_mismatch" as const }
      }
      if (run.dispatchGeneration !== input.job.dispatchGeneration) {
        return { state: "not_eligible" as const, reason: "stale_dispatch" as const }
      }
      if (run.cancellationRequestedAt !== null) {
        return { state: "not_eligible" as const, reason: "cancelled" as const }
      }
      const unavailableRun = {
        state: "not_eligible" as const,
        reason: run.status === "retry_wait" ? ("retry_wait" as const) : ("already_claimed" as const)
      }
      return run.claimExpiresAt === null
        ? unavailableRun
        : { ...unavailableRun, retryAt: run.claimExpiresAt }
    }
    const request = await loadRequest(acquired.owner_id, acquired.input_snapshot_json)
    const checkpoints = await loadCheckpoints(acquired.run_id, acquired.owner_id)
    return {
      state: "acquired" as const,
      authority: {
        runId: acquired.run_id,
        attemptId: acquired.attempt_id,
        attemptFence: acquired.attempt_fence,
        controlRevision: acquired.control_revision,
        leaseExpiresAt: acquired.lease_expires_at
      },
      request,
      checkpoints
    }
  }

  async function renew(input: RenewAgentRunLease): Promise<AgentRunAttemptAuthority> {
    const [renewedRun, renewedAttempt] = await Effect.runPromise(
      allInTransaction(database, [
        database
          .update(agentRuns)
          .set({
            claimExpiresAt: sql`to_char(
              clock_timestamp() + (${input.leaseMs} * interval '1 millisecond'),
              'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
            )`
          })
          .where(activeAuthority(input.authority, true))
          .returning({ leaseExpiresAt: agentRuns.claimExpiresAt }),
        database
          .update(agentRunAttempts)
          .set({
            leaseExpiresAt: sql`to_char(
              clock_timestamp() + (${input.leaseMs} * interval '1 millisecond'),
              'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
            )`
          })
          .where(
            and(
              eq(agentRunAttempts.id, input.authority.attemptId),
              eq(agentRunAttempts.runId, input.authority.runId),
              eq(agentRunAttempts.fence, input.authority.attemptFence),
              eq(agentRunAttempts.status, "running")
            )
          )
          .returning({ id: agentRunAttempts.id })
      ])
    )
    const leaseExpiresAt = renewedRun[0]?.leaseExpiresAt
    if (
      leaseExpiresAt === null ||
      leaseExpiresAt === undefined ||
      renewedAttempt[0] === undefined
    ) {
      throw authorityLost(input.authority)
    }
    return { ...input.authority, leaseExpiresAt }
  }

  async function readControl(authority: AgentRunAttemptAuthority) {
    const [row] = await Effect.runPromise(
      database
        .select({
          revision: agentRuns.controlRevision,
          cancellationRequestedAt: agentRuns.cancellationRequestedAt,
          reason: agentRuns.cancellationReason
        })
        .from(agentRuns)
        .where(activeAuthority(authority, false))
        .limit(1)
    )
    if (row === undefined) throw authorityLost(authority)
    const control = {
      revision: row.revision,
      cancellationRequested: row.cancellationRequestedAt !== null
    }
    return row.reason === null ? control : { ...control, reason: row.reason }
  }

  async function appendCheckpoint(input: AppendAgentRunCheckpoint) {
    const operation = Schema.decodeUnknownSync(AgentRunOperation)(input.operation)
    if (operation.runId !== input.authority.runId) throw authorityLost(input.authority)
    const serialized = JSON.stringify(operation)
    const hash = await protection.contentHash(serialized)
    const [existing] = await Effect.runPromise(
      database
        .select({
          kind: agentRunOperations.kind,
          loopVersion: agentRunOperations.loopVersion,
          payloadHash: agentRunOperations.payloadHash
        })
        .from(agentRunOperations)
        .where(
          and(
            eq(agentRunOperations.runId, operation.runId),
            eq(agentRunOperations.sequence, operation.sequence)
          )
        )
        .limit(1)
    )
    if (existing !== undefined) {
      if (
        existing.kind === operation.kind &&
        existing.loopVersion === operation.loopVersion &&
        existing.payloadHash === hash
      ) {
        return "duplicate" as const
      }
      throw new AgentRunCheckpointConflict({ runId: operation.runId, sequence: operation.sequence })
    }
    const [run] = await Effect.runPromise(
      database
        .select({ ownerId: agentRuns.userId })
        .from(agentRuns)
        .where(activeAuthority(input.authority, true))
        .limit(1)
    )
    if (run === undefined) throw authorityLost(input.authority)
    const owner = await ownerDataKeys.load(run.ownerId)
    const encrypted = await protection.encryptText(owner.key, JSON.stringify(operation.payload))
    const inserted = await Effect.runPromise(
      database.execute<{ id: string }>(
        sql`
        INSERT INTO agent_run_operations (
          id, run_id, sequence, kind, loop_version, payload_ciphertext, payload_iv,
          payload_hash, data_key_version, created_by_attempt_id, created_at
        )
        SELECT ${randomUuid()}, ${operation.runId}, ${operation.sequence}, ${operation.kind},
          ${operation.loopVersion}, ${encrypted.ciphertext}, ${encrypted.iv}, ${hash},
          ${owner.version}, ${input.authority.attemptId}, ${databaseNow}
        FROM agent_runs
        WHERE id = ${input.authority.runId}
          AND status = 'running'
          AND active_attempt_id = ${input.authority.attemptId}
          AND active_attempt_fence = ${input.authority.attemptFence}
          AND control_revision = ${input.authority.controlRevision}
          AND cancellation_requested_at IS NULL
          AND claim_expires_at::timestamptz > clock_timestamp()
          AND ${operation.sequence} = COALESCE(
            (SELECT MAX(sequence) + 1 FROM agent_run_operations WHERE run_id = ${operation.runId}),
            1
          )
        ON CONFLICT (run_id, sequence) DO NOTHING
        RETURNING id
      `,
        "objects"
      )
    )
    if (inserted[0] !== undefined) return "appended" as const
    const [settled] = await Effect.runPromise(
      database
        .select({ payloadHash: agentRunOperations.payloadHash })
        .from(agentRunOperations)
        .where(
          and(
            eq(agentRunOperations.runId, operation.runId),
            eq(agentRunOperations.sequence, operation.sequence)
          )
        )
        .limit(1)
    )
    if (settled?.payloadHash === hash) return "duplicate" as const
    if (settled !== undefined) {
      throw new AgentRunCheckpointConflict({ runId: operation.runId, sequence: operation.sequence })
    }
    throw authorityLost(input.authority)
  }

  async function recordOutcome(input: RecordAgentRunOutcome) {
    const result = Schema.decodeUnknownSync(AgentRunResult)(input.result)
    if (result.runId !== input.authority.runId) throw authorityLost(input.authority)
    const serialized = JSON.stringify(result)
    const hash = await protection.contentHash(serialized)
    const [current] = await Effect.runPromise(
      database
        .select({ ownerId: agentRuns.userId, outcomeHash: agentRuns.outcomeHash })
        .from(agentRuns)
        .where(eq(agentRuns.id, input.authority.runId))
        .limit(1)
    )
    if (current === undefined) throw authorityLost(input.authority)
    if (current.outcomeHash !== null) {
      if (current.outcomeHash === hash) return "duplicate" as const
      throw authorityLost(input.authority)
    }
    const owner = await ownerDataKeys.load(current.ownerId)
    const encrypted = await protection.encryptText(owner.key, serialized)
    const envelope = JSON.stringify({
      ciphertext: encrypted.ciphertext,
      iv: encrypted.iv,
      keyVersion: owner.version
    })
    const at = new Date().toISOString()
    const continuationId = randomUuid()
    const cancellationClause =
      result.status === "cancelled"
        ? sql`true`
        : sql`${agentRuns.controlRevision} = ${input.authority.controlRevision}
          AND ${agentRuns.cancellationRequestedAt} IS NULL`
    const [updated, continuation, attempt] = await Effect.runPromise(
      allInTransaction(database, [
        database
          .update(agentRuns)
          .set({
            status: "awaiting_finalization",
            outcomeSnapshotJson: envelope,
            outcomeHash: hash,
            claimExpiresAt: null,
            completedAt: at
          })
          .where(and(activeAuthority(input.authority, false), cancellationClause))
          .returning({ id: agentRuns.id }),
        database
          .insert(agentRunOutbox)
          .select(
            database
              .select({
                id: sql<string>`${continuationId}`.as("id"),
                runId: agentRuns.id,
                kind: sql<"continuation">`${"continuation"}`.as("kind"),
                generation: agentRuns.activeAttemptFence,
                state: sql<"pending">`${"pending"}`.as("state"),
                availableAt: sql<string>`${at}`.as("available_at"),
                claimedAt: sql<string | null>`NULL`.as("claimed_at"),
                claimToken: sql<string | null>`NULL`.as("claim_token"),
                claimExpiresAt: sql<string | null>`NULL`.as("claim_expires_at"),
                publishedAt: sql<string | null>`NULL`.as("published_at"),
                failureCount: sql<number>`0`.as("failure_count"),
                createdAt: sql<string>`${at}`.as("created_at")
              })
              .from(agentRuns)
              .where(
                and(
                  eq(agentRuns.id, input.authority.runId),
                  eq(agentRuns.status, "awaiting_finalization"),
                  eq(agentRuns.outcomeHash, hash),
                  eq(agentRuns.activeAttemptId, input.authority.attemptId),
                  eq(agentRuns.activeAttemptFence, input.authority.attemptFence)
                )
              )
          )
          .onConflictDoNothing()
          .returning({ id: agentRunOutbox.id }),
        database
          .update(agentRunAttempts)
          .set({ status: "executed", errorCode: result.errorCode })
          .where(
            and(
              eq(agentRunAttempts.id, input.authority.attemptId),
              eq(agentRunAttempts.runId, input.authority.runId),
              eq(agentRunAttempts.fence, input.authority.attemptFence),
              eq(agentRunAttempts.status, "running")
            )
          )
          .returning({ id: agentRunAttempts.id }),
        database
          .update(conversationTurns)
          .set({ claimExpiresAt: null, updatedAt: at })
          .where(
            and(
              eq(
                conversationTurns.id,
                sql`(
                SELECT turn_id
                FROM agent_runs
                WHERE id = ${input.authority.runId}
                  AND origin_type = 'conversation_turn'
                  AND status = 'awaiting_finalization'
                  AND outcome_hash = ${hash}
              )`
              ),
              eq(conversationTurns.activeRunId, input.authority.runId),
              eq(conversationTurns.status, "running")
            )
          )
      ])
    )
    if (updated[0] === undefined || continuation[0] === undefined || attempt[0] === undefined) {
      throw authorityLost(input.authority)
    }
    return "accepted" as const
  }

  return AgentRunGateway.of({
    acquire: (input) =>
      Effect.tryPromise({
        try: () => acquire(input),
        catch: (cause) => unavailable("acquire", cause)
      }),
    renew: (input) =>
      Effect.tryPromise({
        try: () => renew(input),
        catch: (cause) => preserveGatewayError("renew", cause)
      }),
    appendCheckpoint: (input) =>
      Effect.tryPromise({
        try: () => appendCheckpoint(input),
        catch: (cause) =>
          cause instanceof AgentRunCheckpointConflict
            ? cause
            : preserveGatewayError("appendCheckpoint", cause)
      }),
    readControl: (authority) =>
      Effect.tryPromise({
        try: () => readControl(authority),
        catch: (cause) => preserveGatewayError("readControl", cause)
      }),
    recordOutcome: (input) =>
      Effect.tryPromise({
        try: () => recordOutcome(input),
        catch: (cause) => preserveGatewayError("recordOutcome", cause)
      })
  })
}

function terminalStatus(status: string) {
  return [
    "awaiting_finalization",
    "completed",
    "failed",
    "cancelled",
    "superseded",
    "indeterminate",
    "unknown"
  ].includes(status)
}

function authorityLost(authority: AgentRunAttemptAuthority) {
  return new AgentRunAuthorityLost({ runId: authority.runId, attemptId: authority.attemptId })
}

function activeAuthority(authority: AgentRunAttemptAuthority, requireCurrentControl: boolean) {
  return and(
    eq(agentRuns.id, authority.runId),
    eq(agentRuns.status, "running"),
    eq(agentRuns.activeAttemptId, authority.attemptId),
    eq(agentRuns.activeAttemptFence, authority.attemptFence),
    sql`${agentRuns.claimExpiresAt}::timestamptz > clock_timestamp()`,
    ...(requireCurrentControl
      ? [
          eq(agentRuns.controlRevision, authority.controlRevision),
          sql`${agentRuns.cancellationRequestedAt} IS NULL`
        ]
      : [])
  )
}

export function agentRunGatewayLayer(service: AgentRunGatewayService) {
  return Layer.succeed(AgentRunGateway, service)
}
