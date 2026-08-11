import { AgentRunRequest } from "@bob/contracts/agent"
import { ReminderCreateArguments, ToolCommand, type ToolResult } from "@bob/contracts/tools"
import { and, eq, isNull, lt, or, sql } from "drizzle-orm"
import { Context, Layer, Schema } from "effect"

import type { CoreDatabase } from "../../database.ts"
import { JournalStore } from "../journal/store.ts"
import { MemoryStore } from "../memory/store.ts"
import type { DataProtection } from "../policy/data-protection.ts"
import { ReminderStore } from "../reminders/store.ts"
import {
  isTrainingMutationTool,
  makeTrainingProposalStore,
  type TrainingProposalSummary
} from "../training/proposal-store.ts"
import { TrainingStore } from "../training/store.ts"
import { isTrainingMutationRequest } from "../training/rules.ts"
import { agentRuns, inboundEvents, toolCalls, users } from "./schema.ts"

const SearchArguments = Schema.Struct({ query: Schema.String })
const CandidateArguments = Schema.Struct({
  scope: Schema.String,
  key: Schema.String,
  value: Schema.Json,
  canonicalText: Schema.String,
  assertionKind: Schema.Literals(["user_stated", "system_recorded", "inferred"]),
  originClass: Schema.Literals([
    "owner_input",
    "system_record",
    "recalled_content",
    "tool_output",
    "assistant_output",
    "background_model"
  ]),
  sourceType: Schema.String,
  sourceId: Schema.String,
  extractionConfidence: Schema.Number,
  importance: Schema.Number,
  explicitRemember: Schema.Boolean
})
const IdArguments = Schema.Struct({ id: Schema.String })
const JournalMetadataArguments = Schema.Struct({ tag: Schema.optionalKey(Schema.String) })
const OptionalRoutineArguments = Schema.Struct({ id: Schema.optionalKey(Schema.String) })
const WorkoutHistoryArguments = Schema.Struct({
  routineId: Schema.optionalKey(Schema.String)
})

type JsonValue = typeof Schema.Json.Type

function jsonObject(value: unknown): { readonly [key: string]: JsonValue } {
  return JSON.parse(JSON.stringify(value)) as { readonly [key: string]: JsonValue }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value)
  }
  if (typeof value === "string") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (typeof value === "object") {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`
  }
  throw new Error("Tool command contains an unsupported value")
}

export async function toolCommandHash(command: typeof ToolCommand.Type): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      canonicalJson({
        ownerId: command.ownerId,
        runId: command.runId,
        toolCallId: command.toolCallId,
        idempotencyKey: command.idempotencyKey,
        name: command.name,
        arguments: command.arguments
      })
    )
  )
  return `sha256:${[...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")}`
}

export interface ToolExecutor {
  execute(input: unknown): Promise<ToolResult>
  listTrainingProposals(ownerId: string): Promise<readonly TrainingProposalSummary[]>
  approveTrainingProposal(
    ownerId: string,
    proposalId: string,
    proposalHash: string,
    approvalIdempotencyKey: string
  ): Promise<ToolResult>
}

export const ToolExecutor = Context.Service<ToolExecutor>("bob/ToolExecutor")

export function makeToolExecutor(
  database: CoreDatabase,
  protection: DataProtection,
  services: {
    reminders: ReminderStore
    memory: MemoryStore
    journal: JournalStore
    training: TrainingStore
  },
  options: {
    readonly uiBaseUrl: string
    readonly now?: () => Date
    readonly randomUuid?: () => string
    readonly toolLeaseMs?: number
  }
): ToolExecutor {
  const now = options.now ?? (() => new Date())
  const randomUuid = options.randomUuid ?? (() => crypto.randomUUID())
  const toolLeaseMs = options.toolLeaseMs ?? 60_000
  const trainingProposals = makeTrainingProposalStore(database, protection, services.training, {
    now,
    randomUuid
  })

  async function ownerKey(ownerId: string): Promise<CryptoKey> {
    const [owner] = await database.select().from(users).where(eq(users.id, ownerId)).limit(1)
    if (
      owner?.wrappedDataKey === null ||
      owner?.wrappedDataKey === undefined ||
      owner.wrappedDataKeyIv === null ||
      owner.wrappedDataKeyIv === undefined ||
      owner.dataKeyVersion === null ||
      owner.dataKeyVersion === undefined
    ) {
      throw new Error("Owner data key is unavailable")
    }
    return protection.unwrapDataKey({
      ciphertext: owner.wrappedDataKey,
      iv: owner.wrappedDataKeyIv,
      version: owner.dataKeyVersion
    })
  }

  async function encodePrivate(ownerId: string, value: unknown): Promise<string> {
    const encrypted = await protection.encryptText(await ownerKey(ownerId), JSON.stringify(value))
    return JSON.stringify(encrypted)
  }

  async function decodePrivate<T>(ownerId: string, value: string): Promise<T> {
    const encrypted = JSON.parse(value) as { ciphertext: string; iv: string }
    return JSON.parse(await protection.decryptText(await ownerKey(ownerId), encrypted)) as T
  }

  async function runContext(runId: string) {
    const [row] = await database
      .select({ run: agentRuns, inbound: inboundEvents })
      .from(agentRuns)
      .innerJoin(inboundEvents, eq(agentRuns.inboundEventId, inboundEvents.id))
      .where(eq(agentRuns.id, runId))
      .limit(1)
    if (row === undefined) throw new Error("Agent run not found")
    const envelope = JSON.parse(row.run.inputSnapshotJson) as {
      ciphertext: string
      iv: string
      keyVersion: number
    }
    const request = Schema.decodeUnknownSync(AgentRunRequest)(
      JSON.parse(await protection.decryptText(await ownerKey(row.run.userId), envelope))
    )
    return { request, channelId: row.inbound.channelId, messageId: row.inbound.messageId }
  }

  async function dispatch(command: typeof ToolCommand.Type): Promise<ToolResult> {
    const context = await runContext(command.runId)
    if (
      context.request.ownerId !== command.ownerId ||
      !context.request.allowedTools.includes(command.name)
    ) {
      return { ok: false, code: "policy_denied", message: "This tool is not allowed for this run." }
    }

    if (isTrainingMutationTool(command.name)) {
      if (!isTrainingMutationRequest(context.request.userText)) {
        return {
          ok: false,
          code: "approval_required",
          message: "Use an affirmative command, then approve the exact proposal in Bob."
        }
      }
      const proposal = await trainingProposals.propose({
        ownerId: command.ownerId,
        runId: command.runId,
        toolCallId: command.toolCallId,
        toolName: command.name,
        commandIdempotencyKey: command.idempotencyKey,
        arguments: command.arguments,
        sourceMessageId: context.messageId
      })
      return {
        ok: true,
        code: "training_proposed",
        message: "Review this training change in Bob before it is applied.",
        data: {
          proposalId: proposal.id,
          proposalHash: proposal.proposalHash,
          status: proposal.status
        }
      }
    }

    switch (command.name) {
      case "reminder_create": {
        const args = Schema.decodeUnknownSync(ReminderCreateArguments)(command.arguments)
        if (args.sourceMessageId !== context.messageId) {
          return { ok: false, code: "source_mismatch", message: "The reminder source is invalid." }
        }
        const result = await services.reminders.createOneShot(
          command.ownerId,
          context.channelId,
          context.request.userText,
          args,
          command.idempotencyKey
        )
        return {
          ok: true,
          code: result.duplicate ? "reminder_exists" : "reminder_created",
          message: `Reminder set for ${result.localDisplayTime} ${args.timeZone}.`,
          data: jsonObject(result)
        }
      }
      case "reminder_list": {
        const list = await services.reminders.list(command.ownerId)
        return {
          ok: true,
          code: "reminder_list",
          message: `${list.length} reminders found.`,
          data: jsonObject({ reminders: list })
        }
      }
      case "memory_search": {
        const args = Schema.decodeUnknownSync(SearchArguments)(command.arguments)
        const matches = await services.memory.search(command.ownerId, args.query, true)
        return {
          ok: true,
          code: "memory_results",
          message: `${matches.length} sources found.`,
          data: jsonObject({ matches })
        }
      }
      case "memory_propose": {
        const args = Schema.decodeUnknownSync(CandidateArguments)(command.arguments)
        const result = await services.memory.propose(
          {
            ownerId: command.ownerId,
            ...args,
            authority: "agent"
          },
          command.idempotencyKey
        )
        return {
          ok: true,
          code: "memory_proposed",
          message: "The memory change is ready for review.",
          data: result
        }
      }
      case "memory_confirm": {
        return {
          ok: false,
          code: "policy_denied",
          message: "Only the owner review flow can confirm a memory."
        }
      }
      case "journal_link_create": {
        const handoff = await services.journal.createHandoff(
          command.ownerId,
          10 * 60_000,
          command.idempotencyKey
        )
        return {
          ok: true,
          code: "journal_link_created",
          message: "Open the private journal link. It expires in 10 minutes.",
          data: {
            path: `${options.uiBaseUrl}/journal/${handoff.id}`,
            expiresAt: handoff.expiresAt,
            bearerToken: false
          }
        }
      }
      case "journal_search_metadata": {
        const args = Schema.decodeUnknownSync(JournalMetadataArguments)(command.arguments)
        const entries = await services.journal.searchMetadata(command.ownerId, args.tag)
        return {
          ok: true,
          code: "journal_metadata",
          message: `${entries.length} journal entries found.`,
          data: { entries }
        }
      }
      case "routine_get": {
        const args = Schema.decodeUnknownSync(OptionalRoutineArguments)(command.arguments)
        const routine = await services.training.getRoutine(command.ownerId, args.id)
        if (routine === undefined) {
          return { ok: true, code: "routine_not_found", message: "No routine was found." }
        }
        return {
          ok: true,
          code: "routine_found",
          message: "The routine was found.",
          data: jsonObject({ routine })
        }
      }
      case "workout_last": {
        const args = Schema.decodeUnknownSync(WorkoutHistoryArguments)(command.arguments)
        const workout = await services.training.lastWorkout(command.ownerId, args.routineId)
        if (workout === undefined) {
          return { ok: true, code: "workout_not_found", message: "No workout was found." }
        }
        return {
          ok: true,
          code: "workout_last",
          message: "The latest workout was found.",
          data: jsonObject({ workout })
        }
      }
      case "workout_history": {
        const args = Schema.decodeUnknownSync(WorkoutHistoryArguments)(command.arguments)
        const history = await services.training.history(command.ownerId, args.routineId)
        return {
          ok: true,
          code: "workout_history",
          message: `${history.length} workouts found.`,
          data: jsonObject({ history })
        }
      }
      case "reminder_acknowledge":
      case "reminder_complete":
      case "reminder_snooze":
      case "reminder_cancel":
      case "memory_correct":
        return {
          ok: false,
          code: "use_bound_command",
          message: "Use the bound owner action for this change."
        }
    }
  }

  return {
    listTrainingProposals: (ownerId) => trainingProposals.list(ownerId),
    approveTrainingProposal: (ownerId, proposalId, proposalHash, approvalIdempotencyKey) =>
      trainingProposals.approve(ownerId, proposalId, proposalHash, approvalIdempotencyKey),
    async execute(input) {
      const command = Schema.decodeUnknownSync(ToolCommand)(input)
      const commandHash = await toolCommandHash(command)
      const [existing] = await database
        .select()
        .from(toolCalls)
        .where(eq(toolCalls.idempotencyKey, command.idempotencyKey))
        .limit(1)
      const ownsCommand = (row: typeof toolCalls.$inferSelect): boolean =>
        row.idempotencyKey === command.idempotencyKey &&
        row.ownerId === command.ownerId &&
        row.runId === command.runId &&
        row.toolCallId === command.toolCallId &&
        row.toolName === command.name &&
        row.commandHash === commandHash
      if (existing !== undefined && !ownsCommand(existing)) {
        return {
          ok: false,
          code: "policy_denied",
          message: "This idempotency key belongs to a different tool call."
        }
      }
      if (existing?.resultJson !== null && existing?.resultJson !== undefined) {
        return decodePrivate<ToolResult>(command.ownerId, existing.resultJson)
      }

      const id = randomUuid()
      await database
        .insert(toolCalls)
        .values({
          id,
          runId: command.runId,
          toolCallId: command.toolCallId,
          idempotencyKey: command.idempotencyKey,
          ownerId: command.ownerId,
          toolName: command.name,
          commandHash,
          argumentsJson: await encodePrivate(command.ownerId, command.arguments),
          status: "pending",
          createdAt: now().toISOString()
        })
        .onConflictDoNothing()
      const [winner] = await database
        .select()
        .from(toolCalls)
        .where(
          or(
            eq(toolCalls.idempotencyKey, command.idempotencyKey),
            and(eq(toolCalls.runId, command.runId), eq(toolCalls.toolCallId, command.toolCallId))
          )
        )
        .limit(1)
      if (winner === undefined || !ownsCommand(winner)) {
        return {
          ok: false,
          code: "policy_denied",
          message: "This idempotency key belongs to a different tool call."
        }
      }
      if (winner.resultJson !== null) {
        return decodePrivate<ToolResult>(command.ownerId, winner.resultJson)
      }
      const claimedAt = now()
      const claimToken = randomUuid()
      const [claimed] = await database
        .update(toolCalls)
        .set({
          status: "executing",
          claimToken,
          claimedAt: claimedAt.toISOString(),
          claimExpiresAt: new Date(claimedAt.getTime() + toolLeaseMs).toISOString(),
          attemptNumber: sql`${toolCalls.attemptNumber} + 1`
        })
        .where(
          and(
            eq(toolCalls.id, winner.id),
            eq(toolCalls.idempotencyKey, command.idempotencyKey),
            eq(toolCalls.ownerId, command.ownerId),
            eq(toolCalls.runId, command.runId),
            eq(toolCalls.toolCallId, command.toolCallId),
            eq(toolCalls.toolName, command.name),
            eq(toolCalls.commandHash, commandHash),
            isNull(toolCalls.resultJson),
            or(
              eq(toolCalls.status, "pending"),
              and(
                eq(toolCalls.status, "executing"),
                lt(toolCalls.claimExpiresAt, claimedAt.toISOString())
              )
            )
          )
        )
        .returning({ id: toolCalls.id })
      if (claimed === undefined) {
        const [settled] = await database
          .select()
          .from(toolCalls)
          .where(eq(toolCalls.id, winner.id))
          .limit(1)
        if (settled === undefined || !ownsCommand(settled)) {
          return {
            ok: false,
            code: "policy_denied",
            message: "This idempotency key belongs to a different tool call."
          }
        }
        if (settled.resultJson !== null) {
          return decodePrivate<ToolResult>(command.ownerId, settled.resultJson)
        }
        return {
          ok: false,
          code: "tool_in_progress",
          message: "This tool call is already running."
        }
      }

      try {
        const result = await dispatch(command)
        await database
          .update(toolCalls)
          .set({
            resultJson: await encodePrivate(command.ownerId, result),
            status: result.ok ? "completed" : "failed",
            claimToken: null,
            claimExpiresAt: null,
            completedAt: now().toISOString()
          })
          .where(
            and(
              eq(toolCalls.id, claimed.id),
              eq(toolCalls.status, "executing"),
              eq(toolCalls.claimToken, claimToken)
            )
          )
        return result
      } catch {
        const result: ToolResult = {
          ok: false,
          code: "domain_error",
          message: "Bob could not complete this action safely."
        }
        await database
          .update(toolCalls)
          .set({
            resultJson: await encodePrivate(command.ownerId, result),
            status: "failed",
            claimToken: null,
            claimExpiresAt: null,
            completedAt: now().toISOString()
          })
          .where(
            and(
              eq(toolCalls.id, claimed.id),
              eq(toolCalls.status, "executing"),
              eq(toolCalls.claimToken, claimToken)
            )
          )
        return result
      }
    }
  }
}

export function toolExecutorLayer(executor: ToolExecutor) {
  return Layer.succeed(ToolExecutor, executor)
}
