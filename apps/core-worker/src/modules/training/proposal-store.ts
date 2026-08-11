import { type ToolCommand, type ToolName, type ToolResult } from "@bob/contracts/tools"
import { and, desc, eq } from "drizzle-orm"
import { Context, Layer, Schema } from "effect"

import type { CoreDatabase } from "../../database.ts"
import { messages, users } from "../conversations/schema.ts"
import type { DataProtection } from "../policy/data-protection.ts"
import { trainingProposals } from "./schema.ts"
import type { TrainingStore } from "./store.ts"

const GymArguments = Schema.Struct({ name: Schema.String })
const ExerciseArguments = Schema.Struct({
  name: Schema.String,
  instructions: Schema.optionalKey(Schema.String)
})
const EquipmentArguments = Schema.Struct({
  gymId: Schema.String,
  name: Schema.String,
  identifier: Schema.optionalKey(Schema.String)
})
const EquipmentMappingArguments = Schema.Struct({
  equipmentId: Schema.String,
  exerciseId: Schema.String
})
const RoutineArguments = Schema.Struct({
  name: Schema.String,
  steps: Schema.Array(
    Schema.Struct({
      exerciseId: Schema.String,
      targetSets: Schema.optionalKey(Schema.Int),
      targetReps: Schema.optionalKey(Schema.Int),
      notes: Schema.optionalKey(Schema.String)
    })
  )
})
const WorkoutStartArguments = Schema.Struct({
  routineId: Schema.String,
  gymId: Schema.optionalKey(Schema.String)
})
const WorkoutSetArguments = Schema.Struct({
  sessionId: Schema.String,
  routineStepId: Schema.String,
  equipmentId: Schema.optionalKey(Schema.String),
  sequence: Schema.Int,
  repetitions: Schema.Int,
  weightGrams: Schema.optionalKey(Schema.Int),
  notes: Schema.optionalKey(Schema.String)
})
const IdArguments = Schema.Struct({ id: Schema.String })

export const trainingMutationToolNames = [
  "gym_create",
  "exercise_create",
  "gym_add_equipment",
  "equipment_map_exercise",
  "routine_save",
  "workout_start",
  "workout_log_set",
  "workout_finish"
] as const satisfies readonly ToolName[]

export type TrainingMutationToolName = (typeof trainingMutationToolNames)[number]

const trainingMutationToolSet = new Set<ToolName>(trainingMutationToolNames)

export function isTrainingMutationTool(name: ToolName): name is TrainingMutationToolName {
  return trainingMutationToolSet.has(name)
}

type JsonObject = ToolCommand["arguments"]

export interface TrainingProposalSummary {
  readonly id: string
  readonly proposalHash: string
  readonly toolName: TrainingMutationToolName
  readonly arguments: JsonObject
  readonly status: "proposed" | "applying" | "applied" | "rejected"
  readonly createdAt: string
  readonly approvedAt?: string
  readonly appliedAt?: string
}

export interface TrainingProposalStore {
  propose(input: {
    readonly ownerId: string
    readonly runId: string
    readonly toolCallId: string
    readonly toolName: TrainingMutationToolName
    readonly commandIdempotencyKey: string
    readonly arguments: JsonObject
    readonly sourceMessageId: string
  }): Promise<TrainingProposalSummary>
  list(ownerId: string): Promise<readonly TrainingProposalSummary[]>
  approve(
    ownerId: string,
    proposalId: string,
    proposalHash: string,
    approvalIdempotencyKey: string
  ): Promise<ToolResult>
}

export const TrainingProposalStore = Context.Service<TrainingProposalStore>(
  "bob/TrainingProposalStore"
)

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
  throw new Error("Training proposal contains an unsupported value")
}

async function commandHash(input: {
  readonly ownerId: string
  readonly runId: string
  readonly toolCallId: string
  readonly toolName: TrainingMutationToolName
  readonly commandIdempotencyKey: string
  readonly arguments: JsonObject
  readonly sourceMessageId: string
}): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(input))
  )
  const hex = [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")
  return `sha256:${hex}`
}

export function makeTrainingProposalStore(
  database: CoreDatabase,
  protection: DataProtection,
  training: TrainingStore,
  options: { readonly now?: () => Date; readonly randomUuid?: () => string }
): TrainingProposalStore {
  const now = options.now ?? (() => new Date())
  const randomUuid = options.randomUuid ?? (() => crypto.randomUUID())

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

  async function summary(
    ownerId: string,
    row: typeof trainingProposals.$inferSelect
  ): Promise<TrainingProposalSummary> {
    if (row.userId !== ownerId || !isTrainingMutationTool(row.toolName as ToolName)) {
      throw new Error("Training proposal does not belong to the owner")
    }
    return {
      id: row.id,
      proposalHash: row.proposalHash,
      toolName: row.toolName as TrainingMutationToolName,
      arguments: await decodePrivate<JsonObject>(ownerId, row.argumentsJson),
      status: row.status,
      createdAt: row.createdAt,
      ...(row.approvedAt === null ? {} : { approvedAt: row.approvedAt }),
      ...(row.appliedAt === null ? {} : { appliedAt: row.appliedAt })
    }
  }

  async function applyProposal(
    ownerId: string,
    row: typeof trainingProposals.$inferSelect
  ): Promise<ToolResult> {
    const argumentsValue = await decodePrivate<JsonObject>(ownerId, row.argumentsJson)
    const idempotencyKey = row.commandIdempotencyKey
    switch (row.toolName as TrainingMutationToolName) {
      case "gym_create": {
        const args = Schema.decodeUnknownSync(GymArguments)(argumentsValue)
        const gymId = await training.createGym(ownerId, args.name, idempotencyKey)
        return { ok: true, code: "gym_created", message: "The gym is saved.", data: { gymId } }
      }
      case "exercise_create": {
        const args = Schema.decodeUnknownSync(ExerciseArguments)(argumentsValue)
        const exerciseId = await training.createExercise(
          ownerId,
          args.name,
          args.instructions,
          idempotencyKey
        )
        return {
          ok: true,
          code: "exercise_created",
          message: "The exercise is saved.",
          data: { exerciseId }
        }
      }
      case "gym_add_equipment": {
        const args = Schema.decodeUnknownSync(EquipmentArguments)(argumentsValue)
        const equipmentId = await training.addEquipment(
          ownerId,
          args.gymId,
          args.name,
          args.identifier,
          idempotencyKey
        )
        return {
          ok: true,
          code: "equipment_created",
          message: "The equipment is saved.",
          data: { equipmentId }
        }
      }
      case "equipment_map_exercise": {
        const args = Schema.decodeUnknownSync(EquipmentMappingArguments)(argumentsValue)
        const mappingId = await training.mapEquipment(
          ownerId,
          args.equipmentId,
          args.exerciseId,
          idempotencyKey
        )
        return {
          ok: true,
          code: "equipment_mapped",
          message: "The equipment mapping is saved.",
          data: { mappingId }
        }
      }
      case "routine_save": {
        const args = Schema.decodeUnknownSync(RoutineArguments)(argumentsValue)
        const routineId = await training.saveRoutine(
          {
            ownerId,
            name: args.name,
            steps: args.steps,
            approvalEvidence: { sourceType: "owner_ui", sourceId: row.id }
          },
          idempotencyKey
        )
        return {
          ok: true,
          code: "routine_saved",
          message: "The approved routine is saved.",
          data: { routineId }
        }
      }
      case "workout_start": {
        const args = Schema.decodeUnknownSync(WorkoutStartArguments)(argumentsValue)
        const sessionId = await training.startWorkout(
          ownerId,
          args.routineId,
          args.gymId,
          idempotencyKey
        )
        return {
          ok: true,
          code: "workout_started",
          message: "The workout is started.",
          data: { sessionId }
        }
      }
      case "workout_log_set": {
        const args = Schema.decodeUnknownSync(WorkoutSetArguments)(argumentsValue)
        const result = await training.logSet(ownerId, args, idempotencyKey)
        return {
          ok: true,
          code: "set_logged",
          message: "The set is logged.",
          data: result
        }
      }
      case "workout_finish": {
        const args = Schema.decodeUnknownSync(IdArguments)(argumentsValue)
        await training.finishWorkout(ownerId, args.id, idempotencyKey)
        return {
          ok: true,
          code: "workout_finished",
          message: "The workout is finished.",
          data: { sessionId: args.id }
        }
      }
    }
  }

  return {
    async propose(input) {
      const [source] = await database
        .select({ id: messages.id })
        .from(messages)
        .where(
          and(
            eq(messages.id, input.sourceMessageId),
            eq(messages.userId, input.ownerId),
            eq(messages.direction, "inbound")
          )
        )
        .limit(1)
      if (source === undefined) throw new Error("Training proposal source is invalid")
      const proposalHash = await commandHash(input)
      await database
        .insert(trainingProposals)
        .values({
          id: randomUuid(),
          userId: input.ownerId,
          runId: input.runId,
          toolCallId: input.toolCallId,
          toolName: input.toolName,
          commandIdempotencyKey: input.commandIdempotencyKey,
          proposalHash,
          argumentsJson: await encodePrivate(input.ownerId, input.arguments),
          sourceMessageId: input.sourceMessageId,
          status: "proposed",
          createdAt: now().toISOString()
        })
        .onConflictDoNothing()
      const [winner] = await database
        .select()
        .from(trainingProposals)
        .where(
          and(
            eq(trainingProposals.runId, input.runId),
            eq(trainingProposals.toolCallId, input.toolCallId)
          )
        )
        .limit(1)
      if (
        winner === undefined ||
        winner.userId !== input.ownerId ||
        winner.toolName !== input.toolName ||
        winner.commandIdempotencyKey !== input.commandIdempotencyKey ||
        winner.proposalHash !== proposalHash ||
        winner.sourceMessageId !== input.sourceMessageId
      ) {
        throw new Error("Training proposal identity conflict")
      }
      return summary(input.ownerId, winner)
    },

    async list(ownerId) {
      const rows = await database
        .select()
        .from(trainingProposals)
        .where(eq(trainingProposals.userId, ownerId))
        .orderBy(desc(trainingProposals.createdAt))
        .limit(50)
      return Promise.all(rows.map((row) => summary(ownerId, row)))
    },

    async approve(ownerId, proposalId, proposalHash, approvalIdempotencyKey) {
      let [proposal] = await database
        .select()
        .from(trainingProposals)
        .where(and(eq(trainingProposals.id, proposalId), eq(trainingProposals.userId, ownerId)))
        .limit(1)
      if (proposal === undefined) throw new Error("Training proposal does not belong to the owner")
      if (proposal.proposalHash !== proposalHash) throw new Error("Training proposal hash mismatch")
      if (proposal.status === "rejected") throw new Error("Training proposal was rejected")
      if (proposal.status === "applied") {
        if (proposal.resultJson === null) throw new Error("Training proposal result is unavailable")
        return decodePrivate<ToolResult>(ownerId, proposal.resultJson)
      }

      if (proposal.status === "proposed") {
        const [approvalOwner] = await database
          .select({ id: trainingProposals.id, proposalHash: trainingProposals.proposalHash })
          .from(trainingProposals)
          .where(
            and(
              eq(trainingProposals.userId, ownerId),
              eq(trainingProposals.approvalIdempotencyKey, approvalIdempotencyKey)
            )
          )
          .limit(1)
        if (
          approvalOwner !== undefined &&
          (approvalOwner.id !== proposal.id || approvalOwner.proposalHash !== proposalHash)
        ) {
          throw new Error("Approval idempotency key belongs to another proposal")
        }
        await database
          .update(trainingProposals)
          .set({
            status: "applying",
            approvalIdempotencyKey,
            approvedAt: now().toISOString()
          })
          .where(
            and(
              eq(trainingProposals.id, proposal.id),
              eq(trainingProposals.userId, ownerId),
              eq(trainingProposals.proposalHash, proposalHash),
              eq(trainingProposals.status, "proposed")
            )
          )
        ;[proposal] = await database
          .select()
          .from(trainingProposals)
          .where(and(eq(trainingProposals.id, proposalId), eq(trainingProposals.userId, ownerId)))
          .limit(1)
      }
      if (
        proposal === undefined ||
        proposal.status !== "applying" ||
        proposal.proposalHash !== proposalHash ||
        proposal.approvalIdempotencyKey !== approvalIdempotencyKey
      ) {
        throw new Error("Training proposal approval identity conflict")
      }

      const result = await applyProposal(ownerId, proposal)
      const encryptedResult = await encodePrivate(ownerId, result)
      await database
        .update(trainingProposals)
        .set({ status: "applied", resultJson: encryptedResult, appliedAt: now().toISOString() })
        .where(
          and(
            eq(trainingProposals.id, proposal.id),
            eq(trainingProposals.userId, ownerId),
            eq(trainingProposals.proposalHash, proposalHash),
            eq(trainingProposals.approvalIdempotencyKey, approvalIdempotencyKey),
            eq(trainingProposals.status, "applying")
          )
        )
      return result
    }
  }
}

export function trainingProposalStoreLayer(store: TrainingProposalStore) {
  return Layer.succeed(TrainingProposalStore, store)
}
