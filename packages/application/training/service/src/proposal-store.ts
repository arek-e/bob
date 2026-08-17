import type { CoreDatabase } from "@bob/db-types"
import type { DataProtection } from "@bob/policy-types/data-protection"
import type { OwnerDataKeyStoreAdapter } from "@bob/policy-types/owner-data-key"

import { messages } from "@bob/db-service/schema/conversations"
import { trainingProposals } from "@bob/db-service/schema/training"
import { makeOwnerDataKeyStore } from "@bob/policy-service/owner-data-key"
import { JsonObject as JsonObjectSchema } from "@bob/shared-types/json"
import { type ToolCommand, type ToolName, ToolResult } from "@bob/tools-types/tools"
import {
  EquipmentMapExerciseArguments,
  ExerciseCreateArguments,
  GymAddEquipmentArguments,
  GymCreateArguments,
  RoutineSaveArguments,
  WorkoutFinishArguments,
  WorkoutLogSetArguments,
  WorkoutStartArguments
} from "@bob/training-types/capability"
import { and, desc, eq } from "drizzle-orm"
import { Effect, Context, Layer, Schema } from "effect"

import type { TrainingStore } from "./store.ts"

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

const TrainingMutationTool = Schema.Literals(trainingMutationToolNames)

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

function isJsonObject(value: typeof Schema.Json.Type): value is typeof JsonObjectSchema.Type {
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
  options: {
    readonly now?: () => Date
    readonly randomUuid?: () => string
    readonly ownerDataKeys?: OwnerDataKeyStoreAdapter
  }
): TrainingProposalStore {
  const now = options.now ?? (() => new Date())
  const randomUuid = options.randomUuid ?? (() => crypto.randomUUID())
  const ownerDataKeys =
    options.ownerDataKeys ??
    makeOwnerDataKeyStore(database, protection, { defaultTimeZone: "UTC", now })

  async function encodePrivate<Input>(ownerId: string, value: Input): Promise<string> {
    const encrypted = await protection.encryptText(
      (await ownerDataKeys.load(ownerId)).key,
      JSON.stringify(value)
    )
    return JSON.stringify(encrypted)
  }

  async function decodePrivate<S extends Schema.ConstraintDecoder<unknown>>(
    ownerId: string,
    value: string,
    schema: S
  ): Promise<S["Type"]> {
    const encrypted = Schema.decodeUnknownSync(
      Schema.Struct({ ciphertext: Schema.String, iv: Schema.String })
    )(JSON.parse(value))
    const plaintext = await protection.decryptText(
      (await ownerDataKeys.load(ownerId)).key,
      encrypted
    )
    return Schema.decodeUnknownSync(schema)(JSON.parse(plaintext))
  }

  async function summary(
    ownerId: string,
    row: typeof trainingProposals.$inferSelect
  ): Promise<TrainingProposalSummary> {
    if (row.userId !== ownerId) {
      throw new Error("Training proposal does not belong to the owner")
    }
    const toolName = Schema.decodeUnknownSync(TrainingMutationTool)(row.toolName)
    const proposal = {
      id: row.id,
      proposalHash: row.proposalHash,
      toolName,
      arguments: await decodePrivate(ownerId, row.argumentsJson, JsonObjectSchema),
      status: row.status,
      createdAt: row.createdAt
    }
    if (row.approvedAt === null && row.appliedAt === null) return proposal
    if (row.approvedAt === null) {
      if (row.appliedAt === null) return proposal
      return { ...proposal, appliedAt: row.appliedAt }
    }
    if (row.appliedAt === null) return { ...proposal, approvedAt: row.approvedAt }
    return { ...proposal, approvedAt: row.approvedAt, appliedAt: row.appliedAt }
  }

  async function applyProposal(
    ownerId: string,
    row: typeof trainingProposals.$inferSelect
  ): Promise<ToolResult> {
    const argumentsValue = await decodePrivate(ownerId, row.argumentsJson, JsonObjectSchema)
    const idempotencyKey = row.commandIdempotencyKey
    switch (Schema.decodeUnknownSync(TrainingMutationTool)(row.toolName)) {
      case "gym_create": {
        const args = Schema.decodeUnknownSync(GymCreateArguments)(argumentsValue)
        const gymId = await training.createGym(ownerId, args.name, idempotencyKey)
        return { ok: true, code: "gym_created", message: "The gym is saved.", data: { gymId } }
      }
      case "exercise_create": {
        const args = Schema.decodeUnknownSync(ExerciseCreateArguments)(argumentsValue)
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
        const args = Schema.decodeUnknownSync(GymAddEquipmentArguments)(argumentsValue)
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
        const args = Schema.decodeUnknownSync(EquipmentMapExerciseArguments)(argumentsValue)
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
        const args = Schema.decodeUnknownSync(RoutineSaveArguments)(argumentsValue)
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
        const args = Schema.decodeUnknownSync(WorkoutLogSetArguments)(argumentsValue)
        const result = await training.logSet(ownerId, args, idempotencyKey)
        return {
          ok: true,
          code: "set_logged",
          message: "The set is logged.",
          data: result
        }
      }
      case "workout_finish": {
        const args = Schema.decodeUnknownSync(WorkoutFinishArguments)(argumentsValue)
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
      const [source] = await Effect.runPromise(
        database
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
      )
      if (source === undefined) throw new Error("Training proposal source is invalid")
      const proposalHash = await commandHash(input)
      await Effect.runPromise(
        database
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
      )
      const [winner] = await Effect.runPromise(
        database
          .select()
          .from(trainingProposals)
          .where(
            and(
              eq(trainingProposals.runId, input.runId),
              eq(trainingProposals.toolCallId, input.toolCallId)
            )
          )
          .limit(1)
      )
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
      const rows = await Effect.runPromise(
        database
          .select()
          .from(trainingProposals)
          .where(eq(trainingProposals.userId, ownerId))
          .orderBy(desc(trainingProposals.createdAt))
          .limit(50)
      )
      return Promise.all(rows.map((row) => summary(ownerId, row)))
    },

    async approve(ownerId, proposalId, proposalHash, approvalIdempotencyKey) {
      let [proposal] = await Effect.runPromise(
        database
          .select()
          .from(trainingProposals)
          .where(and(eq(trainingProposals.id, proposalId), eq(trainingProposals.userId, ownerId)))
          .limit(1)
      )
      if (proposal === undefined) throw new Error("Training proposal does not belong to the owner")
      if (proposal.proposalHash !== proposalHash) throw new Error("Training proposal hash mismatch")
      if (proposal.status === "rejected") throw new Error("Training proposal was rejected")
      if (proposal.status === "applied") {
        if (proposal.resultJson === null) throw new Error("Training proposal result is unavailable")
        return decodePrivate(ownerId, proposal.resultJson, ToolResult)
      }

      if (proposal.status === "proposed") {
        const [approvalOwner] = await Effect.runPromise(
          database
            .select({ id: trainingProposals.id, proposalHash: trainingProposals.proposalHash })
            .from(trainingProposals)
            .where(
              and(
                eq(trainingProposals.userId, ownerId),
                eq(trainingProposals.approvalIdempotencyKey, approvalIdempotencyKey)
              )
            )
            .limit(1)
        )
        if (
          approvalOwner !== undefined &&
          (approvalOwner.id !== proposal.id || approvalOwner.proposalHash !== proposalHash)
        ) {
          throw new Error("Approval idempotency key belongs to another proposal")
        }
        await Effect.runPromise(
          database
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
        )
        ;[proposal] = await Effect.runPromise(
          database
            .select()
            .from(trainingProposals)
            .where(and(eq(trainingProposals.id, proposalId), eq(trainingProposals.userId, ownerId)))
            .limit(1)
        )
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
      await Effect.runPromise(
        database
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
      )
      return result
    }
  }
}

export function trainingProposalStoreLayer(store: TrainingProposalStore) {
  return Layer.succeed(TrainingProposalStore, store)
}
