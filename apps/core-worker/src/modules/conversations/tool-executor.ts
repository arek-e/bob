import { AgentRunRequest } from "@bob/contracts/agent"
import {
  conversationMutationIdempotencyKey,
  isReadOnlyToolName,
  ToolCommand,
  type ToolName,
  type ToolResult
} from "@bob/contracts/tools"
import { and, eq, exists, isNull, lt, or, sql } from "drizzle-orm"
import { Context, Layer, Schema } from "effect"

import type { CoreDatabase } from "../../database.ts"
import type { ConnectionStore } from "../connections/store.ts"
import type { JournalStore } from "../journal/store.ts"
import type { MemoryStore } from "../memory/store.ts"
import type { DataProtection } from "../policy/data-protection.ts"
import type { ReminderStore } from "../reminders/store.ts"
import type { OwnerSettingsStore } from "../settings/store.ts"
import type { TrainingStore } from "../training/store.ts"

import { makeConnectionsToolAdapter } from "../connections/tool-adapter.ts"
import { makeJournalToolAdapter } from "../journal/tool-adapter.ts"
import { makeMemoryToolAdapter } from "../memory/tool-adapter.ts"
import { makeReminderToolAdapter } from "../reminders/tool-adapter.ts"
import { makeSettingsToolAdapter } from "../settings/tool-adapter.ts"
import { makeTrainingModule, type TrainingModule } from "../training/module.ts"
import { makeTrainingProposalStore } from "../training/proposal-store.ts"
import { makeTrainingToolAdapter } from "../training/tool-adapter.ts"
import { agentRuns, conversationTurns, inboundEvents, toolCalls, users } from "./schema.ts"
import {
  type ToolCommandAdapter,
  type ToolCommandAdapterContext,
  type ToolRunContext
} from "./tool-adapter.ts"

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

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value)
  }
  if (typeof value === "string") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (typeof value === "object") {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`
  }
  throw new Error("Tool command contains an unsupported value")
}

export interface ToolExecutor {
  execute(input: unknown): Promise<ToolResult>
}

/**
 * Temporary factory compatibility for callers that still construct an
 * executor directly. The composed ToolExecutor service does not expose it.
 */
export interface LegacyTrainingProposalAccess {
  listTrainingProposals(ownerId: string): ReturnType<TrainingModule["listTrainingProposals"]>
  approveTrainingProposal: TrainingModule["approveTrainingProposal"]
}

export const ToolExecutor = Context.Service<ToolExecutor>("bob/ToolExecutor")

type ToolServices = {
  reminders: ReminderStore
  memory: MemoryStore
  journal: JournalStore
  training: TrainingStore | TrainingModule
  settings?: OwnerSettingsStore
  connections?: ConnectionStore
}

type ToolExecutorImplementation = ToolExecutor & LegacyTrainingProposalAccess

function hasTrainingModule(training: ToolServices["training"]): training is TrainingModule {
  return (
    "proposeTraining" in training &&
    typeof training.proposeTraining === "function" &&
    "listTrainingProposals" in training &&
    typeof training.listTrainingProposals === "function" &&
    "approveTrainingProposal" in training &&
    typeof training.approveTrainingProposal === "function"
  )
}

function denied(): ToolResult {
  return { ok: false, code: "policy_denied", message: "This tool is not allowed for this run." }
}

function domainError(): ToolResult {
  return {
    ok: false,
    code: "domain_error",
    message: "Bob could not complete this action safely."
  }
}

function conversationPolicyText(request: typeof AgentRunRequest.Type): string {
  return request.currentTurnMessages?.map((message) => message.text).join("\n") ?? request.userText
}

const mutationRetractionPhrases = [
  "never mind",
  "nevermind",
  "forget that",
  "forget it",
  "cancel that",
  "cancel it",
  "scratch that",
  "ignore that",
  "do not",
  "don't",
  "dont",
  "can you not",
  "could you not",
  "would you not",
  "stop",
  "glöm det",
  "strunta i det",
  "skippa det",
  "avbryt",
  "gör inte",
  "gör det inte",
  "kan du inte",
  "skulle du inte",
  "nej"
] as const

const mutationHesitationPhrases = [
  "wait",
  "hold on",
  "hang on",
  "pause",
  "vänta",
  "vänta lite",
  "håll an"
] as const

const mutationReviewQuestion =
  /^(?:what|why|how|when|where|who|which|will|would|can|could|should|does|do|did|is|are|am|vad|varför|hur|när|var|vem|vilken|vilka|kommer|skulle|kan|bör|gör|gjorde|är)\b/u
const directMutationRequestQuestion = /^(?:(?:can|could|would|will) you|(?:kan|skulle) du)\b/u

function normalizedLatestFragment(request: typeof AgentRunRequest.Type): string {
  return (request.currentTurnMessages?.at(-1)?.text ?? request.userText)
    .normalize("NFKC")
    .toLocaleLowerCase("sv-SE")
    .replace(/[.!?,;:]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
}

function latestFragmentBlocksMutation(request: typeof AgentRunRequest.Type): boolean {
  const normalized = normalizedLatestFragment(request)
  const retracts = mutationRetractionPhrases.some(
    (phrase) =>
      normalized === phrase ||
      normalized.startsWith(`${phrase} `) ||
      normalized.endsWith(` ${phrase}`) ||
      normalized.includes(` ${phrase} `)
  )
  if (retracts) return true
  if (
    mutationHesitationPhrases.some(
      (phrase) => normalized === phrase || normalized.startsWith(`${phrase} `)
    )
  ) {
    return true
  }
  return mutationReviewQuestion.test(normalized) && !directMutationRequestQuestion.test(normalized)
}

const externalMutationTools = new Set<ToolName>(["connection_link_create"])

export function expiredToolCallOutcome(name: ToolName): ToolResult | undefined {
  if (!externalMutationTools.has(name)) return undefined
  return {
    ok: false,
    code: "external_outcome_unknown",
    message: "The external action result is unknown. Open Bob before trying again."
  }
}

export function makeToolExecutor(
  database: CoreDatabase,
  protection: DataProtection,
  services: ToolServices,
  options: {
    readonly uiBaseUrl: string
    readonly now?: () => Date
    readonly randomUuid?: () => string
    readonly toolLeaseMs?: number
  }
): ToolExecutorImplementation {
  const now = options.now ?? (() => new Date())
  const randomUuid = options.randomUuid ?? (() => crypto.randomUUID())
  const toolLeaseMs = options.toolLeaseMs ?? 60_000
  const training = hasTrainingModule(services.training)
    ? services.training
    : makeTrainingModule(
        services.training,
        makeTrainingProposalStore(database, protection, services.training, {
          now,
          randomUuid
        })
      )

  const adapters = {
    reminders: makeReminderToolAdapter(services.reminders),
    memory: makeMemoryToolAdapter(services.memory),
    journal: makeJournalToolAdapter(services.journal, { uiBaseUrl: options.uiBaseUrl }),
    training: makeTrainingToolAdapter(training),
    settings: makeSettingsToolAdapter(services.settings, services.connections),
    connections: makeConnectionsToolAdapter(services.connections, services.settings)
  } satisfies Readonly<Record<string, ToolCommandAdapter>>

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
    if (request.sourceMessageId !== row.inbound.messageId) {
      throw new Error("Agent source snapshot does not match the inbound message")
    }
    return {
      request,
      channelId: row.inbound.channelId,
      messageId: row.inbound.messageId,
      runStatus: row.run.status,
      claimExpiresAt: row.run.claimExpiresAt
    }
  }

  function conversationTurnAuthority() {
    return or(
      and(isNull(agentRuns.conversationTurnId), isNull(agentRuns.conversationTurnRevision)),
      exists(
        database
          .select({ id: conversationTurns.id })
          .from(conversationTurns)
          .where(
            and(
              eq(conversationTurns.id, agentRuns.conversationTurnId),
              eq(conversationTurns.revision, agentRuns.conversationTurnRevision),
              eq(conversationTurns.activeRunId, agentRuns.id),
              eq(conversationTurns.activeRunRevision, agentRuns.conversationTurnRevision)
            )
          )
      )
    )
  }

  async function runCanClaimTool(runId: string): Promise<boolean> {
    const [run] = await database
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(and(eq(agentRuns.id, runId), conversationTurnAuthority()))
      .limit(1)
    return run !== undefined
  }

  async function conversationTurnForRun(runId: string) {
    const [run] = await database
      .select({
        conversationTurnId: agentRuns.conversationTurnId,
        ownerId: agentRuns.userId,
        targetMessageId: agentRuns.targetMessageId
      })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId))
      .limit(1)
    return run
  }

  async function dispatch(command: typeof ToolCommand.Type): Promise<ToolResult> {
    const context = await runContext(command.runId)
    if (
      context.runStatus !== "executing" ||
      context.claimExpiresAt === null ||
      Date.parse(context.claimExpiresAt) <= now().getTime() ||
      context.request.runId !== command.runId ||
      context.request.ownerId !== command.ownerId ||
      !context.request.allowedTools.includes(command.name)
    ) {
      return denied()
    }
    if (!isReadOnlyToolName(command.name) && latestFragmentBlocksMutation(context.request)) {
      return denied()
    }

    const run: ToolRunContext = {
      request: { ...context.request, userText: conversationPolicyText(context.request) },
      channelId: context.channelId,
      messageId: context.messageId
    }
    const adapterContext: ToolCommandAdapterContext = { command, run }
    switch (command.name) {
      case "reminder_create":
      case "reminder_list":
      case "reminder_acknowledge":
      case "reminder_complete":
      case "reminder_snooze":
      case "reminder_cancel":
        return adapters.reminders.execute(adapterContext)
      case "memory_search":
      case "memory_propose":
      case "memory_confirm":
      case "memory_correct":
        return adapters.memory.execute(adapterContext)
      case "journal_link_create":
      case "journal_search_metadata":
        return adapters.journal.execute(adapterContext)
      case "gym_list":
      case "gym_create":
      case "equipment_list":
      case "exercise_create":
      case "exercise_list":
      case "gym_add_equipment":
      case "equipment_map_exercise":
      case "routine_save":
      case "routine_get":
      case "workout_start":
      case "workout_log_set":
      case "workout_finish":
      case "workout_last":
      case "workout_history":
        return adapters.training.execute(adapterContext)
      case "settings_get":
      case "settings_update":
        return adapters.settings.execute(adapterContext)
      case "connection_list":
      case "connection_link_create":
        return adapters.connections.execute(adapterContext)
      default:
        return domainError()
    }
  }

  const executor: ToolExecutorImplementation = {
    listTrainingProposals: (ownerId) => training.listTrainingProposals(ownerId),
    approveTrainingProposal: (ownerId, proposalId, proposalHash, approvalIdempotencyKey) =>
      training.approveTrainingProposal(ownerId, proposalId, proposalHash, approvalIdempotencyKey),
    async execute(input) {
      const command = Schema.decodeUnknownSync(ToolCommand)(input)
      const commandRun = await conversationTurnForRun(command.runId)
      if (commandRun !== undefined && commandRun.ownerId !== command.ownerId) return denied()
      const stableMutationTurnId =
        commandRun?.conversationTurnId !== null &&
        commandRun?.conversationTurnId !== undefined &&
        !isReadOnlyToolName(command.name)
          ? commandRun.conversationTurnId
          : undefined
      if (
        stableMutationTurnId !== undefined &&
        command.name === "reminder_create" &&
        command.arguments.sourceMessageId !== commandRun?.targetMessageId
      ) {
        return denied()
      }
      if (
        stableMutationTurnId !== undefined &&
        command.idempotencyKey !==
          (await conversationMutationIdempotencyKey({
            ownerId: command.ownerId,
            conversationTurnId: stableMutationTurnId,
            toolName: command.name,
            arguments: command.arguments
          }))
      ) {
        return denied()
      }
      const commandHash = await toolCommandHash(command)
      const [existing] = await database
        .select()
        .from(toolCalls)
        .where(eq(toolCalls.idempotencyKey, command.idempotencyKey))
        .limit(1)
      const ownsCommand = (
        row: typeof toolCalls.$inferSelect,
        rowConversationTurnId: string | undefined
      ): boolean => {
        if (
          row.idempotencyKey !== command.idempotencyKey ||
          row.ownerId !== command.ownerId ||
          row.toolName !== command.name
        ) {
          return false
        }
        if (stableMutationTurnId !== undefined) {
          return rowConversationTurnId === stableMutationTurnId
        }
        return (
          row.runId === command.runId &&
          row.toolCallId === command.toolCallId &&
          row.commandHash === commandHash
        )
      }
      const existingTurnId =
        existing === undefined
          ? undefined
          : ((await conversationTurnForRun(existing.runId))?.conversationTurnId ?? undefined)
      if (existing !== undefined && !ownsCommand(existing, existingTurnId)) return denied()
      if (existing?.resultJson !== null && existing?.resultJson !== undefined) {
        return decodePrivate<ToolResult>(command.ownerId, existing.resultJson)
      }

      const id = randomUuid()
      const argumentsJson = await encodePrivate(command.ownerId, command.arguments)
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
          argumentsJson,
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
      const winnerTurnId =
        winner === undefined
          ? undefined
          : ((await conversationTurnForRun(winner.runId))?.conversationTurnId ?? undefined)
      if (winner === undefined || !ownsCommand(winner, winnerTurnId)) return denied()
      if (winner.resultJson !== null) {
        return decodePrivate<ToolResult>(command.ownerId, winner.resultJson)
      }

      const claimedAt = now()
      const expiredOutcome = expiredToolCallOutcome(command.name)
      if (
        expiredOutcome !== undefined &&
        winner.status === "executing" &&
        winner.claimExpiresAt !== null &&
        Date.parse(winner.claimExpiresAt) < claimedAt.getTime()
      ) {
        const [markedUnknown] = await database
          .update(toolCalls)
          .set({
            resultJson: await encodePrivate(command.ownerId, expiredOutcome),
            status: "unknown",
            claimToken: null,
            claimExpiresAt: null
          })
          .where(
            and(
              eq(toolCalls.id, winner.id),
              eq(toolCalls.status, "executing"),
              isNull(toolCalls.resultJson),
              lt(toolCalls.claimExpiresAt, claimedAt.toISOString())
            )
          )
          .returning({ id: toolCalls.id })
        if (markedUnknown !== undefined) return expiredOutcome
        const [settled] = await database
          .select()
          .from(toolCalls)
          .where(eq(toolCalls.id, winner.id))
          .limit(1)
        if (settled?.resultJson !== null && settled?.resultJson !== undefined) {
          return decodePrivate<ToolResult>(command.ownerId, settled.resultJson)
        }
        return {
          ok: false,
          code: "tool_in_progress",
          message: "This tool call is already running."
        }
      }

      const claimToken = randomUuid()
      const commandRunAuthority = exists(
        database
          .select({ id: agentRuns.id })
          .from(agentRuns)
          .where(and(eq(agentRuns.id, command.runId), conversationTurnAuthority()))
      )
      const [claimed] = await database
        .update(toolCalls)
        .set({
          ...(stableMutationTurnId === undefined
            ? {}
            : {
                runId: command.runId,
                toolCallId: command.toolCallId,
                commandHash,
                argumentsJson
              }),
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
            eq(toolCalls.toolName, command.name),
            ...(stableMutationTurnId === undefined
              ? [
                  eq(toolCalls.runId, command.runId),
                  eq(toolCalls.toolCallId, command.toolCallId),
                  eq(toolCalls.commandHash, commandHash)
                ]
              : []),
            isNull(toolCalls.resultJson),
            stableMutationTurnId === undefined
              ? exists(
                  database
                    .select({ id: agentRuns.id })
                    .from(agentRuns)
                    .where(and(eq(agentRuns.id, toolCalls.runId), conversationTurnAuthority()))
                )
              : commandRunAuthority,
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
        if (!(await runCanClaimTool(command.runId))) return denied()
        const [settled] = await database
          .select()
          .from(toolCalls)
          .where(eq(toolCalls.id, winner.id))
          .limit(1)
        const settledTurnId =
          settled === undefined
            ? undefined
            : ((await conversationTurnForRun(settled.runId))?.conversationTurnId ?? undefined)
        if (settled === undefined || !ownsCommand(settled, settledTurnId)) return denied()
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
        const result = domainError()
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
  return executor
}

export function toolExecutorLayer(executor: ToolExecutor) {
  return Layer.succeed(ToolExecutor, executor)
}
