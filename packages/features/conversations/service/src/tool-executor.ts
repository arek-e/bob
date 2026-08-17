import type { ToolExecutorAdapter } from "@bob/conversations-types/tool-executor"
import type { CoreDatabase } from "@bob/db-types"
import type { DataProtection } from "@bob/policy-types/data-protection"
import type { OwnerDataKeyStoreAdapter } from "@bob/policy-types/owner-data-key"

import { AgentRunRequest } from "@bob/agent-types/run"
import { liftPromiseOperation } from "@bob/capabilities-types/effect-adapter"
import { JsonObject } from "@bob/capabilities-types/json"
import {
  type CapabilityCatalogue,
  conversationMutationIdempotencyKey,
  MAX_TOOL_RESULT_BYTES,
  ToolCommand,
  ToolName,
  ToolResult
} from "@bob/capabilities-types/tools"
import { ToolExecutor, ToolExecutorError } from "@bob/conversations-types/tool-executor"
import {
  agentRuns,
  conversationTurns,
  inboundEvents,
  toolCalls
} from "@bob/db-service/schema/conversations"
import { makeOwnerDataKeyStore } from "@bob/policy-service/owner-data-key"
import { and, eq, exists, gte, inArray, isNull, lt, lte, or, sql } from "drizzle-orm"
import { Effect, Layer, Schema } from "effect"

import {
  type ToolCommandAdapterContext,
  type ToolAdapterRegistry,
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

function isJsonObject(value: typeof Schema.Json.Type): value is typeof JsonObject.Type {
  return value !== null && !Array.isArray(value) && Object(value) === value
}

function canonicalJson(value: typeof Schema.Json.Type): string {
  if (value === null) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (isJsonObject(value)) {
    return `{${Object.keys(value)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] ?? null)}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

export { ToolExecutor }
export type { MutationActivity, ToolExecutorAdapter } from "@bob/conversations-types/tool-executor"

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

export function boundToolResult(result: ToolResult): ToolResult {
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength <= MAX_TOOL_RESULT_BYTES) {
    return result
  }
  const actionOutcome = result.evidence?.actionOutcome
  if (actionOutcome === "unknown") {
    return {
      ok: false,
      code: "external_outcome_unknown",
      message: "The action result is unknown. Review the current state before trying again.",
      evidence: { actionOutcome }
    }
  }
  if (actionOutcome !== undefined) {
    return {
      ok: result.ok,
      code: "tool_result_too_large",
      message: "The action finished, but its detailed result was too large.",
      evidence: { actionOutcome }
    }
  }
  return {
    ok: false,
    code: "tool_result_too_large",
    message: "The tool returned too much data. Use a narrower request."
  }
}

function additionalMutationConfirmationRequired(): ToolResult {
  return {
    ok: false,
    code: "confirmation_required",
    message:
      "Bob already completed one change in this message burst. Confirm another change in a new message."
  }
}

function conversationPolicyText(request: typeof AgentRunRequest.Type): string {
  const messages = request.currentTurnMessages
  if (messages === undefined) return request.userText
  if (directMutationRequestQuestion.test(normalizedLatestFragment(request))) {
    return messages.at(-1)?.text ?? request.userText
  }
  return messages.map((message) => message.text).join("\n")
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
const directMutationRequestQuestion =
  /^(?:(?:can|could|would|will) you(?: please)?|(?:kan|skulle) du(?: snälla)?)\s+(?!(?:explain|describe|clarify|tell|show|förklara|beskriv)\b)\S+/u

function latestFragmentText(request: typeof AgentRunRequest.Type): string {
  return request.currentTurnMessages?.at(-1)?.text ?? request.userText
}

function normalizedLatestFragment(request: typeof AgentRunRequest.Type): string {
  return latestFragmentText(request)
    .normalize("NFKC")
    .toLocaleLowerCase("sv-SE")
    .replace(/[.!?,;:]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
}

function latestFragmentBlocksMutation(request: typeof AgentRunRequest.Type): boolean {
  if ((request.currentTurnMessages?.length ?? 1) < 2) return false
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
  if (/[?？]\s*$/u.test(latestFragmentText(request))) {
    return !directMutationRequestQuestion.test(normalized)
  }
  return mutationReviewQuestion.test(normalized) && !directMutationRequestQuestion.test(normalized)
}

export function expiredToolCallOutcome(
  name: ToolName,
  catalogue: CapabilityCatalogue
): ToolResult | undefined {
  if (!catalogue.hasUnknownExternalOutcome(name)) return undefined
  return {
    ok: false,
    code: "external_outcome_unknown",
    message: "The external action result is unknown. Open Bob before trying again.",
    evidence: { actionOutcome: "unknown" }
  }
}

export function makeToolExecutor(
  database: CoreDatabase,
  protection: DataProtection,
  registry: ToolAdapterRegistry,
  options: {
    readonly now?: () => Date
    readonly randomUuid?: () => string
    readonly toolLeaseMs?: number
    readonly ownerDataKeys?: OwnerDataKeyStoreAdapter
  }
): ToolExecutorAdapter {
  const now = options.now ?? (() => new Date())
  const randomUuid = options.randomUuid ?? (() => crypto.randomUUID())
  const toolLeaseMs = options.toolLeaseMs ?? 60_000
  const ownerDataKeys =
    options.ownerDataKeys ??
    makeOwnerDataKeyStore(database, protection, { defaultTimeZone: "UTC", now })
  const isReadOnly = (name: ToolName) => registry.catalogue.isReadOnly(name)
  const mutatingToolNames = registry.catalogue.names.filter((name) => !isReadOnly(name))

  async function encodePrivate<Input>(ownerId: string, value: Input): Promise<string> {
    const encrypted = await protection.encryptText(
      (await ownerDataKeys.load(ownerId)).key,
      JSON.stringify(value)
    )
    return JSON.stringify(encrypted)
  }

  async function decodePrivate(ownerId: string, value: string): Promise<ToolResult> {
    const encrypted = Schema.decodeUnknownSync(
      Schema.Struct({ ciphertext: Schema.String, iv: Schema.String })
    )(JSON.parse(value))
    const plaintext = await protection.decryptText(
      (await ownerDataKeys.load(ownerId)).key,
      encrypted
    )
    return Schema.decodeUnknownSync(ToolResult)(JSON.parse(plaintext))
  }

  async function runContext(runId: string) {
    const [row] = await Effect.runPromise(
      database
        .select({ run: agentRuns, inbound: inboundEvents })
        .from(agentRuns)
        .innerJoin(inboundEvents, eq(agentRuns.inboundEventId, inboundEvents.id))
        .where(eq(agentRuns.id, runId))
        .limit(1)
    )
    if (row === undefined) throw new Error("Agent run not found")
    const envelope = Schema.decodeUnknownSync(
      Schema.Struct({ ciphertext: Schema.String, iv: Schema.String, keyVersion: Schema.Number })
    )(JSON.parse(row.run.inputSnapshotJson))
    const request = Schema.decodeUnknownSync(AgentRunRequest)(
      JSON.parse(
        await protection.decryptText((await ownerDataKeys.load(row.run.userId)).key, envelope)
      )
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
    const [run] = await Effect.runPromise(
      database
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .where(and(eq(agentRuns.id, runId), conversationTurnAuthority()))
        .limit(1)
    )
    return run !== undefined
  }

  async function conversationTurnForRun(runId: string) {
    const [run] = await Effect.runPromise(
      database
        .select({
          conversationTurnId: agentRuns.conversationTurnId,
          conversationTurnRevision: agentRuns.conversationTurnRevision,
          ownerId: agentRuns.userId,
          targetMessageId: agentRuns.targetMessageId
        })
        .from(agentRuns)
        .where(eq(agentRuns.id, runId))
        .limit(1)
    )
    return run
  }

  async function reserveMutation(
    conversationTurnId: string,
    conversationTurnRevision: number,
    runId: string,
    idempotencyKey: string
  ): Promise<boolean> {
    const [reserved] = await Effect.runPromise(
      database
        .update(conversationTurns)
        .set({ mutationIdempotencyKey: idempotencyKey })
        .where(
          and(
            eq(conversationTurns.id, conversationTurnId),
            eq(conversationTurns.revision, conversationTurnRevision),
            eq(conversationTurns.activeRunId, runId),
            eq(conversationTurns.activeRunRevision, conversationTurnRevision),
            or(
              isNull(conversationTurns.mutationIdempotencyKey),
              eq(conversationTurns.mutationIdempotencyKey, idempotencyKey)
            )
          )
        )
        .returning({ id: conversationTurns.id })
    )
    return reserved !== undefined
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
    const run: ToolRunContext = {
      request: { ...context.request, userText: conversationPolicyText(context.request) },
      channelId: context.channelId,
      messageId: context.messageId
    }
    const adapterContext: ToolCommandAdapterContext = { command, run }
    const adapter = registry.adapterFor(command.name)
    if (adapter === undefined) return denied()
    const result = await adapter.execute(adapterContext)
    if (result.evidence?.actionOutcome !== undefined) return boundToolResult(result)
    const confirmedCodes = registry.catalogue.confirmedActionCodes(command.name)
    if (result.ok && confirmedCodes.includes(result.code)) {
      return boundToolResult({
        ...result,
        evidence: { ...result.evidence, actionOutcome: "confirmed" }
      })
    }
    if (result.code === "external_outcome_unknown") {
      return boundToolResult({
        ...result,
        evidence: { ...result.evidence, actionOutcome: "unknown" }
      })
    }
    return boundToolResult(result)
  }

  const executor: ToolExecutorAdapter = {
    async mutationActivity(runId) {
      const [run] = await Effect.runPromise(
        database
          .select({ conversationTurnId: agentRuns.conversationTurnId })
          .from(agentRuns)
          .where(eq(agentRuns.id, runId))
          .limit(1)
      )
      if (run === undefined) return { status: "none" }
      const rows = await Effect.runPromise(
        database
          .select({
            runId: toolCalls.runId,
            status: toolCalls.status,
            resultJson: toolCalls.resultJson,
            claimExpiresAt: toolCalls.claimExpiresAt,
            completedAt: toolCalls.completedAt,
            attemptNumber: toolCalls.attemptNumber,
            runRevision: agentRuns.conversationTurnRevision
          })
          .from(toolCalls)
          .innerJoin(agentRuns, eq(agentRuns.id, toolCalls.runId))
          .where(
            and(
              run.conversationTurnId === null
                ? eq(toolCalls.runId, runId)
                : eq(agentRuns.conversationTurnId, run.conversationTurnId),
              inArray(toolCalls.toolName, mutatingToolNames)
            )
          )
      )
      const currentTime = now()
      const active = rows.filter(
        (row) => (row.status === "pending" || row.status === "executing") && row.resultJson === null
      )
      if (active.length > 0) {
        let recoveryRequired = false
        const retryAt = active.reduce((latest, row) => {
          const expired =
            row.claimExpiresAt === null || Date.parse(row.claimExpiresAt) <= currentTime.getTime()
          if (expired) recoveryRequired = true
          const candidate = expired
            ? new Date(currentTime.getTime() + toolLeaseMs).toISOString()
            : row.claimExpiresAt!
          return Date.parse(candidate) > Date.parse(latest) ? candidate : latest
        }, currentTime.toISOString())
        const originRevision = active.reduce<number | undefined>(
          (earliest, row) =>
            row.runRevision === null
              ? earliest
              : earliest === undefined || row.runRevision < earliest
                ? row.runRevision
                : earliest,
          undefined
        )
        const activity = {
          status: "active",
          retryAt,
          recoveryRequired,
          recoveryExhausted: active.some((row) => row.attemptNumber >= 2)
        } as const
        return originRevision === undefined ? activity : { ...activity, originRevision }
      }
      const completed = rows.filter((row) => row.status === "completed" && row.resultJson !== null)
      if (completed.length > 0) {
        return {
          status: "completed",
          completedInRun: completed.some((row) => row.runId === runId)
        }
      }
      return rows.some((row) => row.status === "unknown" && row.resultJson !== null)
        ? { status: "unknown" }
        : { status: "none" }
    },
    async expireMutationRecovery(runId) {
      const [run] = await Effect.runPromise(
        database
          .select({
            ownerId: agentRuns.userId,
            conversationTurnId: agentRuns.conversationTurnId,
            conversationTurnRevision: agentRuns.conversationTurnRevision
          })
          .from(agentRuns)
          .where(eq(agentRuns.id, runId))
          .limit(1)
      )
      if (
        run?.conversationTurnId === null ||
        run?.conversationTurnId === undefined ||
        run.conversationTurnRevision === null
      ) {
        return false
      }
      const currentTime = now()
      const resultJson = await encodePrivate(run.ownerId, {
        ok: false,
        code: "tool_recovery_failed",
        message: "The action result is unknown. Review the current state before trying again."
      } satisfies ToolResult)
      const expiredRuns = database
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.conversationTurnId, run.conversationTurnId),
            lt(agentRuns.conversationTurnRevision, run.conversationTurnRevision)
          )
        )
      const recovered = await Effect.runPromise(
        database
          .update(toolCalls)
          .set({
            resultJson,
            status: "unknown",
            claimToken: null,
            claimExpiresAt: null,
            completedAt: currentTime.toISOString()
          })
          .where(
            and(
              or(
                inArray(toolCalls.runId, expiredRuns),
                and(eq(toolCalls.runId, runId), gte(toolCalls.attemptNumber, 2))
              ),
              inArray(toolCalls.toolName, mutatingToolNames),
              inArray(toolCalls.status, ["pending", "executing"]),
              isNull(toolCalls.resultJson),
              or(
                isNull(toolCalls.claimExpiresAt),
                lte(toolCalls.claimExpiresAt, currentTime.toISOString())
              )
            )
          )
          .returning({ id: toolCalls.id })
      )
      return recovered.length > 0
    },
    async execute(input) {
      const command = Schema.decodeUnknownSync(ToolCommand)(input)
      const commandRun = await conversationTurnForRun(command.runId)
      if (commandRun !== undefined && commandRun.ownerId !== command.ownerId) return denied()
      const stableMutationTurnId =
        commandRun?.conversationTurnId !== null &&
        commandRun?.conversationTurnId !== undefined &&
        !isReadOnly(command.name)
          ? commandRun.conversationTurnId
          : undefined
      const sourceMessageArgument = registry.catalogue.sourceMessageArgument(command.name)
      if (
        sourceMessageArgument !== undefined &&
        command.arguments[sourceMessageArgument] !== commandRun?.targetMessageId
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
            arguments: command.arguments,
            excludedArgumentNames: registry.catalogue.mutationArgumentExclusions(command.name)
          }))
      ) {
        return denied()
      }
      if (!isReadOnly(command.name)) {
        const context = await runContext(command.runId)
        if (latestFragmentBlocksMutation(context.request)) return denied()
      }
      if (stableMutationTurnId !== undefined) {
        const revision = commandRun?.conversationTurnRevision
        if (revision === null || revision === undefined) return denied()
        const reserved = await reserveMutation(
          stableMutationTurnId,
          revision,
          command.runId,
          command.idempotencyKey
        )
        if (!reserved) {
          if (!(await runCanClaimTool(command.runId))) return denied()
          return additionalMutationConfirmationRequired()
        }
      }
      const commandHash = await toolCommandHash(command)
      const [existing] = await Effect.runPromise(
        database
          .select()
          .from(toolCalls)
          .where(eq(toolCalls.idempotencyKey, command.idempotencyKey))
          .limit(1)
      )
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
        if (stableMutationTurnId !== undefined && existing.runId !== command.runId) {
          await Effect.runPromise(
            database
              .update(toolCalls)
              .set({ runId: command.runId, toolCallId: command.toolCallId, commandHash })
              .where(
                and(
                  eq(toolCalls.id, existing.id),
                  eq(toolCalls.idempotencyKey, command.idempotencyKey),
                  isNull(toolCalls.claimToken),
                  isNull(toolCalls.claimExpiresAt)
                )
              )
          )
        }
        return decodePrivate(command.ownerId, existing.resultJson)
      }

      const id = randomUuid()
      const argumentsJson = await encodePrivate(command.ownerId, command.arguments)
      await Effect.runPromise(
        database
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
      )
      const [winner] = await Effect.runPromise(
        database
          .select()
          .from(toolCalls)
          .where(
            or(
              eq(toolCalls.idempotencyKey, command.idempotencyKey),
              and(eq(toolCalls.runId, command.runId), eq(toolCalls.toolCallId, command.toolCallId))
            )
          )
          .limit(1)
      )
      const winnerTurnId =
        winner === undefined
          ? undefined
          : ((await conversationTurnForRun(winner.runId))?.conversationTurnId ?? undefined)
      if (winner === undefined || !ownsCommand(winner, winnerTurnId)) return denied()
      if (winner.resultJson !== null) {
        if (stableMutationTurnId !== undefined && winner.runId !== command.runId) {
          await Effect.runPromise(
            database
              .update(toolCalls)
              .set({ runId: command.runId, toolCallId: command.toolCallId, commandHash })
              .where(
                and(
                  eq(toolCalls.id, winner.id),
                  eq(toolCalls.idempotencyKey, command.idempotencyKey),
                  isNull(toolCalls.claimToken),
                  isNull(toolCalls.claimExpiresAt)
                )
              )
          )
        }
        return decodePrivate(command.ownerId, winner.resultJson)
      }

      const claimedAt = now()
      const expiredOutcome = expiredToolCallOutcome(command.name, registry.catalogue)
      if (
        expiredOutcome !== undefined &&
        winner.status === "executing" &&
        winner.claimExpiresAt !== null &&
        Date.parse(winner.claimExpiresAt) < claimedAt.getTime()
      ) {
        const [markedUnknown] = await Effect.runPromise(
          database
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
        )
        if (markedUnknown !== undefined) return expiredOutcome
        const [settled] = await Effect.runPromise(
          database.select().from(toolCalls).where(eq(toolCalls.id, winner.id)).limit(1)
        )
        if (settled?.resultJson !== null && settled?.resultJson !== undefined) {
          return decodePrivate(command.ownerId, settled.resultJson)
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
      const [claimed] = await Effect.runPromise(
        database
          .update(toolCalls)
          .set(
            stableMutationTurnId === undefined
              ? {
                  status: "executing",
                  claimToken,
                  claimedAt: claimedAt.toISOString(),
                  claimExpiresAt: new Date(claimedAt.getTime() + toolLeaseMs).toISOString(),
                  attemptNumber: sql`${toolCalls.attemptNumber} + 1`
                }
              : {
                  runId: command.runId,
                  toolCallId: command.toolCallId,
                  commandHash,
                  argumentsJson,
                  status: "executing",
                  claimToken,
                  claimedAt: claimedAt.toISOString(),
                  claimExpiresAt: new Date(claimedAt.getTime() + toolLeaseMs).toISOString(),
                  attemptNumber: sql`${toolCalls.attemptNumber} + 1`
                }
          )
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
      )
      if (claimed === undefined) {
        if (!(await runCanClaimTool(command.runId))) return denied()
        const [settled] = await Effect.runPromise(
          database.select().from(toolCalls).where(eq(toolCalls.id, winner.id)).limit(1)
        )
        const settledTurnId =
          settled === undefined
            ? undefined
            : ((await conversationTurnForRun(settled.runId))?.conversationTurnId ?? undefined)
        if (settled === undefined || !ownsCommand(settled, settledTurnId)) return denied()
        if (settled.resultJson !== null) {
          return decodePrivate(command.ownerId, settled.resultJson)
        }
        return {
          ok: false,
          code: "tool_in_progress",
          message: "This tool call is already running."
        }
      }

      try {
        const result = await dispatch(command)
        await Effect.runPromise(
          database
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
        )
        return result
      } catch {
        const result = domainError()
        await Effect.runPromise(
          database
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
        )
        return result
      }
    }
  }
  return executor
}

export function toolExecutorLayer(executor: ToolExecutorAdapter) {
  const failure = (operation: keyof ToolExecutorAdapter) => (cause: unknown) =>
    new ToolExecutorError({ operation: String(operation), cause })
  return Layer.succeed(
    ToolExecutor,
    ToolExecutor.of({
      execute: (input) =>
        Effect.tryPromise({
          try: () => executor.execute(input),
          catch: failure("execute")
        }),
      mutationActivity: liftPromiseOperation(
        executor.mutationActivity,
        failure("mutationActivity")
      ),
      expireMutationRecovery: liftPromiseOperation(
        executor.expireMutationRecovery,
        failure("expireMutationRecovery")
      )
    })
  )
}
