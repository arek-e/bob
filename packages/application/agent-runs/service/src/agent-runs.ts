import type {
  AgentRunCommandError,
  AgentRunInspectError,
  AgentRunSubmitError,
  AgentRunView,
  AgentRunsService,
  CancelAgentRun,
  InspectAgentRun,
  SubmitAgentRun
} from "@bob/agent-runs-types/agent-runs"
import type { CoreDatabase } from "@bob/db-types"
import type { DataProtection } from "@bob/policy-types/data-protection"
import type { OwnerDataKeyStoreAdapter } from "@bob/policy-types/owner-data-key"

import {
  AgentRunConflict,
  AgentRunInvalid,
  AgentRunNotFound,
  AgentRunState,
  AgentRunTerminalOutcome,
  AgentRuns,
  AgentRunsUnavailable,
  SubmitAgentRun as SubmitAgentRunSchema
} from "@bob/agent-runs-types/agent-runs"
import { agentRunAttempts, agentRunOutbox, agentRuns } from "@bob/db-service/schema/conversations"
import { allInTransaction } from "@bob/db-types"
import { makeOwnerDataKeyStore } from "@bob/policy-service/owner-data-key"
import { and, eq, sql } from "drizzle-orm"
import { Effect, Layer, Schema } from "effect"

const terminalStates = new Set([
  "completed",
  "failed",
  "cancelled",
  "superseded",
  "indeterminate",
  "unknown"
])

function originId(input: SubmitAgentRun): string {
  switch (input.origin.type) {
    case "conversation_turn":
      return `${input.origin.turnId}:${input.origin.revision}`
    case "scheduled":
      return input.origin.occurrenceId
    case "proactive":
      return input.origin.signalId
  }
}

function publicState(status: string): AgentRunState {
  switch (status) {
    case "pending":
    case "claimed":
      return "queued"
    case "executing":
      return "running"
    case "unknown":
      return "indeterminate"
    default:
      return Schema.decodeUnknownSync(AgentRunState)(status)
  }
}

function outcome(status: string): AgentRunTerminalOutcome | undefined {
  const state = publicState(status)
  if (!terminalStates.has(state)) return undefined
  return Schema.decodeUnknownSync(AgentRunTerminalOutcome)(state)
}

function unavailable(operation: string, cause: unknown) {
  return new AgentRunsUnavailable({ operation, cause })
}

function preserveSubmitError(operation: string, cause: unknown): AgentRunSubmitError {
  if (
    cause instanceof AgentRunConflict ||
    cause instanceof AgentRunInvalid ||
    cause instanceof AgentRunsUnavailable
  ) {
    return cause
  }
  return unavailable(operation, cause)
}

function preserveCommandError(operation: string, cause: unknown): AgentRunCommandError {
  if (cause instanceof AgentRunNotFound || cause instanceof AgentRunsUnavailable) return cause
  return unavailable(operation, cause)
}

function preserveInspectError(operation: string, cause: unknown): AgentRunInspectError {
  if (cause instanceof AgentRunNotFound || cause instanceof AgentRunsUnavailable) return cause
  return unavailable(operation, cause)
}

export function makeAgentRuns(
  database: CoreDatabase,
  protection: DataProtection,
  options: {
    readonly now?: () => Date
    readonly randomUuid?: () => string
    readonly ownerDataKeys?: OwnerDataKeyStoreAdapter
  } = {}
): AgentRunsService {
  const now = options.now ?? (() => new Date())
  const randomUuid = options.randomUuid ?? (() => crypto.randomUUID())
  const ownerDataKeys =
    options.ownerDataKeys ??
    makeOwnerDataKeyStore(database, protection, { defaultTimeZone: "UTC", now })

  async function loadByIdempotency(ownerId: string, idempotencyKey: string) {
    const [row] = await Effect.runPromise(
      database
        .select({
          id: agentRuns.id,
          submissionHash: agentRuns.submissionHash,
          createdAt: agentRuns.createdAt
        })
        .from(agentRuns)
        .where(and(eq(agentRuns.userId, ownerId), eq(agentRuns.idempotencyKey, idempotencyKey)))
        .limit(1)
    )
    return row
  }

  async function submit(input: SubmitAgentRun) {
    const serialized = JSON.stringify(input.request)
    const inputHash = await protection.contentHash(serialized)
    const submissionHash = await protection.contentHash(
      JSON.stringify({ origin: input.origin, request: input.request, execution: input.execution })
    )
    const existing = await loadByIdempotency(input.request.ownerId, input.idempotencyKey)
    if (existing !== undefined) {
      if (existing.submissionHash !== submissionHash)
        throw new AgentRunConflict({ runId: existing.id })
      return {
        runId: existing.id,
        state: "already_accepted" as const,
        acceptedAt: existing.createdAt
      }
    }

    const owner = await ownerDataKeys.load(input.request.ownerId)
    const encrypted = await protection.encryptText(owner.key, serialized)
    const acceptedAt = now().toISOString()
    const outboxId = randomUuid()
    const envelope = JSON.stringify({
      ciphertext: encrypted.ciphertext,
      iv: encrypted.iv,
      keyVersion: owner.version
    })

    try {
      await Effect.runPromise(
        allInTransaction(database, [
          database.insert(agentRuns).values({
            id: input.request.runId,
            userId: input.request.ownerId,
            originType: input.origin.type,
            originId: originId(input),
            conversationTurnId:
              input.origin.type === "conversation_turn" ? input.origin.turnId : undefined,
            conversationTurnRevision:
              input.origin.type === "conversation_turn" ? input.origin.revision : undefined,
            targetMessageId: input.request.sourceMessageId,
            correlationId: input.request.correlationId,
            inputSnapshotJson: envelope,
            inputHash,
            submissionHash,
            status: "accepted",
            model: "configured-at-agent-host",
            idempotencyKey: input.idempotencyKey,
            executionPoolId: input.execution.executionPoolId,
            jobProtocolVersion: input.execution.jobProtocolVersion,
            coreGatewayProtocolVersion: input.execution.coreGatewayProtocolVersion,
            checkpointLoopVersion: input.execution.checkpointLoopVersion,
            dispatchGeneration: 1,
            createdAt: acceptedAt
          }),
          database.insert(agentRunOutbox).values({
            id: outboxId,
            runId: input.request.runId,
            kind: "dispatch",
            generation: 1,
            state: "pending",
            availableAt: acceptedAt,
            createdAt: acceptedAt
          })
        ])
      )
    } catch (cause) {
      const raced = await loadByIdempotency(input.request.ownerId, input.idempotencyKey)
      if (raced === undefined) throw cause
      if (raced.submissionHash !== submissionHash) throw new AgentRunConflict({ runId: raced.id })
      return { runId: raced.id, state: "already_accepted" as const, acceptedAt: raced.createdAt }
    }
    return { runId: input.request.runId, state: "accepted" as const, acceptedAt }
  }

  async function cancel(input: CancelAgentRun) {
    for (let retry = 0; retry < 3; retry += 1) {
      const [current] = await Effect.runPromise(
        database
          .select({
            status: agentRuns.status,
            controlRevision: agentRuns.controlRevision,
            cancellationRequestedAt: agentRuns.cancellationRequestedAt
          })
          .from(agentRuns)
          .where(and(eq(agentRuns.id, input.runId), eq(agentRuns.userId, input.ownerId)))
          .limit(1)
      )
      if (current === undefined) throw new AgentRunNotFound()
      if (current.cancellationRequestedAt !== null) {
        return {
          state:
            current.status === "cancelled" ? ("already_terminal" as const) : ("requested" as const),
          controlRevision: current.controlRevision
        }
      }
      if (terminalStates.has(current.status)) {
        return { state: "already_terminal" as const, controlRevision: current.controlRevision }
      }

      const at = now().toISOString()
      const revision = current.controlRevision + 1
      const outboxId = randomUuid()
      const [updated] = await Effect.runPromise(
        allInTransaction(database, [
          database
            .update(agentRuns)
            .set({
              controlRevision: revision,
              cancellationRequestedAt: at,
              cancellationReason: input.reason,
              status: sql`CASE
                WHEN ${agentRuns.status} IN ('accepted', 'queued', 'pending', 'retry_wait')
                THEN 'cancelled'
                ELSE ${agentRuns.status}
              END`,
              completedAt: sql`CASE
                WHEN ${agentRuns.status} IN ('accepted', 'queued', 'pending', 'retry_wait')
                THEN ${at}
                ELSE ${agentRuns.completedAt}
              END`
            })
            .where(
              and(
                eq(agentRuns.id, input.runId),
                eq(agentRuns.userId, input.ownerId),
                eq(agentRuns.controlRevision, current.controlRevision)
              )
            )
            .returning({ status: agentRuns.status }),
          database
            .insert(agentRunOutbox)
            .select(
              database
                .select({
                  id: sql<string>`${outboxId}`.as("id"),
                  runId: agentRuns.id,
                  kind: sql<"control">`${"control"}`.as("kind"),
                  generation: agentRuns.controlRevision,
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
                    eq(agentRuns.id, input.runId),
                    eq(agentRuns.userId, input.ownerId),
                    eq(agentRuns.controlRevision, revision),
                    eq(agentRuns.cancellationRequestedAt, at)
                  )
                )
            )
            .onConflictDoNothing()
        ])
      )
      const changed = updated[0]
      if (changed !== undefined) {
        return {
          state:
            changed.status === "cancelled"
              ? ("cancelled_before_start" as const)
              : ("requested" as const),
          controlRevision: revision
        }
      }
    }
    throw unavailable("cancel", new Error("Agent Run control revision changed repeatedly"))
  }

  async function inspect(input: InspectAgentRun) {
    const [row] = await Effect.runPromise(
      database
        .select({
          id: agentRuns.id,
          ownerId: agentRuns.userId,
          status: agentRuns.status,
          executionPoolId: agentRuns.executionPoolId,
          createdAt: agentRuns.createdAt,
          startedAt: agentRuns.claimedAt,
          completedAt: agentRuns.completedAt
        })
        .from(agentRuns)
        .where(and(eq(agentRuns.id, input.runId), eq(agentRuns.userId, input.ownerId)))
        .limit(1)
    )
    if (row === undefined) throw new AgentRunNotFound()
    const [attempts] = await Effect.runPromise(
      database
        .select({ count: sql<number>`count(*)::integer` })
        .from(agentRunAttempts)
        .where(eq(agentRunAttempts.runId, row.id))
    )
    const terminalOutcome = outcome(row.status)
    const view: AgentRunView = {
      runId: row.id,
      ownerId: row.ownerId,
      state: publicState(row.status),
      attemptCount: attempts?.count ?? 0,
      executionPoolId: row.executionPoolId ?? "legacy",
      submittedAt: row.createdAt
    }
    if (terminalOutcome !== undefined) Object.assign(view, { outcome: terminalOutcome })
    if (row.startedAt !== null) Object.assign(view, { startedAt: row.startedAt })
    if (row.completedAt !== null) Object.assign(view, { completedAt: row.completedAt })
    return view
  }

  return AgentRuns.of({
    submit: (input) =>
      Effect.flatMap(
        Effect.try({
          try: () => Schema.decodeUnknownSync(SubmitAgentRunSchema)(input),
          catch: (cause) => new AgentRunInvalid({ cause })
        }),
        (decoded) =>
          Effect.tryPromise({
            try: () => submit(decoded),
            catch: (cause) => preserveSubmitError("submit", cause)
          })
      ),
    cancel: (input) =>
      Effect.tryPromise({
        try: () => cancel(input),
        catch: (cause) => preserveCommandError("cancel", cause)
      }),
    inspect: (input) =>
      Effect.tryPromise({
        try: () => inspect(input),
        catch: (cause) => preserveInspectError("inspect", cause)
      })
  })
}

export function agentRunsLayer(service: AgentRunsService) {
  return Layer.succeed(AgentRuns, service)
}
