import { and, desc, eq } from "drizzle-orm"
import { Context, Layer } from "effect"

import type { CoreDatabase } from "../../database.ts"

import { messages } from "../conversations/schema.ts"
import {
  completeEffect,
  completedEffect,
  completedEffectAfterConflict,
  type EffectIdentity
} from "../policy/effect-outcome.ts"
import {
  equipment,
  equipmentExercises,
  exercises,
  gyms,
  routineSteps,
  routines,
  trainingProposals,
  workoutSessions,
  workoutSets
} from "./schema.ts"

export interface RoutineView {
  readonly id: string
  readonly name: string
  readonly revision: number
  readonly steps: readonly {
    readonly id: string
    readonly exerciseId: string
    readonly exerciseName: string
    readonly position: number
    readonly targetSets: number | null
    readonly targetReps: number | null
    readonly notes: string | null
  }[]
}

export interface WorkoutView {
  readonly id: string
  readonly routineId: string
  readonly routineName: string
  readonly gymId: string | null
  readonly status: "active" | "completed" | "stopped_for_safety" | "abandoned"
  readonly startedAt: string
  readonly finishedAt: string | null
  readonly sets: readonly {
    readonly id: string
    readonly routineStepId: string
    readonly equipmentId: string | null
    readonly sequence: number
    readonly repetitions: number
    readonly weightGrams: number | null
    readonly notes: string | null
    readonly loggedAt: string
  }[]
}

export interface TrainingOverview {
  readonly gyms: readonly {
    readonly id: string
    readonly name: string
    readonly equipment: readonly {
      readonly id: string
      readonly name: string
      readonly identifier: string | null
      readonly exerciseIds: readonly string[]
    }[]
  }[]
  readonly exercises: readonly {
    readonly id: string
    readonly name: string
    readonly instructions: string | null
  }[]
  readonly routines: readonly RoutineView[]
  readonly activeWorkout?: WorkoutView
  readonly history: readonly {
    readonly id: string
    readonly routineId: string
    readonly routineName: string
    readonly gymId: string | null
    readonly gymName: string | null
    readonly status: "active" | "completed" | "stopped_for_safety" | "abandoned"
    readonly startedAt: string
    readonly finishedAt: string | null
  }[]
}

export interface TrainingStore {
  createGym(ownerId: string, name: string, idempotencyKey: string): Promise<string>
  createExercise(
    ownerId: string,
    name: string,
    instructions: string | undefined,
    idempotencyKey: string
  ): Promise<string>
  addEquipment(
    ownerId: string,
    gymId: string,
    name: string,
    identifier: string | undefined,
    idempotencyKey: string
  ): Promise<string>
  mapEquipment(
    ownerId: string,
    equipmentId: string,
    exerciseId: string,
    idempotencyKey: string
  ): Promise<string>
  saveRoutine(
    input: {
      ownerId: string
      name: string
      approvalEvidence: {
        sourceType: "owner_message" | "owner_ui"
        sourceId: string
      }
      steps: readonly {
        exerciseId: string
        targetSets?: number
        targetReps?: number
        notes?: string
      }[]
    },
    idempotencyKey: string
  ): Promise<string>
  getRoutine(ownerId: string, routineId?: string): Promise<RoutineView | undefined>
  startWorkout(
    ownerId: string,
    routineId: string,
    gymId: string | undefined,
    idempotencyKey: string
  ): Promise<string>
  logSet(
    ownerId: string,
    input: {
      sessionId: string
      routineStepId: string
      equipmentId?: string
      sequence: number
      repetitions: number
      weightGrams?: number
      notes?: string
    },
    idempotencyKey: string
  ): Promise<{ setId: string; safetyStopped: boolean; response?: string }>
  finishWorkout(ownerId: string, sessionId: string, idempotencyKey: string): Promise<void>
  stopActiveForSafety(
    ownerId: string,
    signal: "pain_or_injury" | "machine_confusion",
    idempotencyKey: string
  ): Promise<string | undefined>
  lastWorkout(ownerId: string, routineId?: string): Promise<WorkoutView | undefined>
  history(ownerId: string, routineId?: string): Promise<readonly unknown[]>
  overview(ownerId: string, query?: string): Promise<TrainingOverview>
}

export const TrainingStore = Context.Service<TrainingStore>("bob/TrainingStore")

export function makeTrainingStore(
  database: CoreDatabase,
  options: { readonly now?: () => Date; readonly randomUuid?: () => string }
): TrainingStore {
  const now = options.now ?? (() => new Date())
  const randomUuid = options.randomUuid ?? (() => crypto.randomUUID())
  return {
    async createGym(ownerId, name, idempotencyKey) {
      const effect: EffectIdentity = { ownerId, kind: "gym_create", idempotencyKey }
      const previous = await completedEffect(database, effect)
      if (previous !== undefined) return previous
      const id = randomUuid()
      const at = now().toISOString()
      try {
        await database.batch([
          database.insert(gyms).values({ id, userId: ownerId, name, createdAt: at, updatedAt: at }),
          completeEffect(database, effect, id, randomUuid(), at)
        ])
      } catch (error) {
        return completedEffectAfterConflict(database, effect, error)
      }
      return id
    },

    async createExercise(ownerId, name, instructions, idempotencyKey) {
      const effect: EffectIdentity = { ownerId, kind: "exercise_create", idempotencyKey }
      const previous = await completedEffect(database, effect)
      if (previous !== undefined) return previous
      const id = randomUuid()
      const at = now().toISOString()
      try {
        await database.batch([
          database.insert(exercises).values({
            id,
            userId: ownerId,
            name,
            instructions,
            createdAt: at
          }),
          completeEffect(database, effect, id, randomUuid(), at)
        ])
      } catch (error) {
        return completedEffectAfterConflict(database, effect, error)
      }
      return id
    },

    async addEquipment(ownerId, gymId, name, identifier, idempotencyKey) {
      const effect: EffectIdentity = { ownerId, kind: "gym_add_equipment", idempotencyKey }
      const previous = await completedEffect(database, effect)
      if (previous !== undefined) return previous
      const [gym] = await database
        .select({ id: gyms.id })
        .from(gyms)
        .where(and(eq(gyms.id, gymId), eq(gyms.userId, ownerId)))
        .limit(1)
      if (gym === undefined) throw new Error("Gym does not belong to the owner")
      const id = randomUuid()
      const at = now().toISOString()
      try {
        await database.batch([
          database.insert(equipment).values({
            id,
            gymId,
            name,
            identifier,
            createdAt: at,
            updatedAt: at
          }),
          completeEffect(database, effect, id, randomUuid(), at)
        ])
      } catch (error) {
        return completedEffectAfterConflict(database, effect, error)
      }
      return id
    },

    async mapEquipment(ownerId, equipmentId, exerciseId, idempotencyKey) {
      const effect: EffectIdentity = {
        ownerId,
        kind: "equipment_map_exercise",
        idempotencyKey
      }
      const previous = await completedEffect(database, effect)
      if (previous !== undefined) return previous
      const [item] = await database
        .select({ id: equipment.id })
        .from(equipment)
        .innerJoin(gyms, eq(equipment.gymId, gyms.id))
        .where(and(eq(equipment.id, equipmentId), eq(gyms.userId, ownerId)))
        .limit(1)
      if (item === undefined) throw new Error("Equipment does not belong to the owner")
      const [exercise] = await database
        .select({ id: exercises.id })
        .from(exercises)
        .where(and(eq(exercises.id, exerciseId), eq(exercises.userId, ownerId)))
        .limit(1)
      if (exercise === undefined) throw new Error("Exercise does not belong to the owner")
      const id = randomUuid()
      const at = now().toISOString()
      try {
        await database.batch([
          database.insert(equipmentExercises).values({
            id,
            equipmentId,
            exerciseId,
            userApprovedAt: at,
            createdAt: at
          }),
          completeEffect(database, effect, id, randomUuid(), at)
        ])
      } catch (error) {
        return completedEffectAfterConflict(database, effect, error)
      }
      return id
    },

    async saveRoutine(input, idempotencyKey) {
      const effect: EffectIdentity = {
        ownerId: input.ownerId,
        kind: "routine_save",
        idempotencyKey
      }
      const previous = await completedEffect(database, effect)
      if (previous !== undefined) return previous
      if (input.approvalEvidence.sourceId.length === 0) {
        throw new Error("Routine approval evidence is required")
      }
      if (input.approvalEvidence.sourceType === "owner_message") {
        const [approvalMessage] = await database
          .select({ id: messages.id })
          .from(messages)
          .where(
            and(
              eq(messages.id, input.approvalEvidence.sourceId),
              eq(messages.userId, input.ownerId),
              eq(messages.direction, "inbound")
            )
          )
          .limit(1)
        if (approvalMessage === undefined) throw new Error("Routine approval evidence is required")
      } else {
        const [approvalProposal] = await database
          .select({ id: trainingProposals.id })
          .from(trainingProposals)
          .where(
            and(
              eq(trainingProposals.id, input.approvalEvidence.sourceId),
              eq(trainingProposals.userId, input.ownerId),
              eq(trainingProposals.toolName, "routine_save"),
              eq(trainingProposals.status, "applying")
            )
          )
          .limit(1)
        if (approvalProposal === undefined) throw new Error("Routine approval evidence is required")
      }
      if (input.steps.length === 0 || input.steps.length > 50) {
        throw new Error("A routine needs between one and 50 steps")
      }
      for (const step of input.steps) {
        if (
          (step.targetSets !== undefined && (step.targetSets < 1 || step.targetSets > 20)) ||
          (step.targetReps !== undefined && (step.targetReps < 1 || step.targetReps > 100))
        ) {
          throw new Error("Routine targets are outside the safe bounds")
        }
        const [exercise] = await database
          .select({ id: exercises.id })
          .from(exercises)
          .where(and(eq(exercises.id, step.exerciseId), eq(exercises.userId, input.ownerId)))
          .limit(1)
        if (exercise === undefined) throw new Error("Routine exercise does not belong to the owner")
      }
      const id = randomUuid()
      const at = now().toISOString()
      try {
        await database.batch([
          database.insert(routines).values({
            id,
            userId: input.ownerId,
            name: input.name,
            revision: 1,
            approvedAt: at,
            approvalSourceType: input.approvalEvidence.sourceType,
            approvalSourceId: input.approvalEvidence.sourceId,
            createdAt: at,
            updatedAt: at
          }),
          ...input.steps.map((step, position) =>
            database.insert(routineSteps).values({
              id: randomUuid(),
              routineId: id,
              exerciseId: step.exerciseId,
              position,
              targetSets: step.targetSets,
              targetReps: step.targetReps,
              notes: step.notes,
              createdAt: at
            })
          ),
          completeEffect(database, effect, id, randomUuid(), at)
        ])
      } catch (error) {
        return completedEffectAfterConflict(database, effect, error)
      }
      return id
    },

    async getRoutine(ownerId, routineId) {
      const [routine] = await database
        .select()
        .from(routines)
        .where(
          routineId === undefined
            ? eq(routines.userId, ownerId)
            : and(eq(routines.id, routineId), eq(routines.userId, ownerId))
        )
        .orderBy(desc(routines.updatedAt))
        .limit(1)
      if (routine === undefined) return undefined
      const steps = await database
        .select({
          id: routineSteps.id,
          exerciseId: routineSteps.exerciseId,
          exerciseName: exercises.name,
          position: routineSteps.position,
          targetSets: routineSteps.targetSets,
          targetReps: routineSteps.targetReps,
          notes: routineSteps.notes
        })
        .from(routineSteps)
        .innerJoin(exercises, eq(routineSteps.exerciseId, exercises.id))
        .where(and(eq(routineSteps.routineId, routine.id), eq(exercises.userId, ownerId)))
        .orderBy(routineSteps.position)
      return {
        id: routine.id,
        name: routine.name,
        revision: routine.revision,
        steps
      }
    },

    async startWorkout(ownerId, routineId, gymId, idempotencyKey) {
      const effect: EffectIdentity = { ownerId, kind: "workout_start", idempotencyKey }
      const previous = await completedEffect(database, effect)
      if (previous !== undefined) return previous
      const [routine] = await database
        .select({
          id: routines.id,
          approvalSourceType: routines.approvalSourceType,
          approvalSourceId: routines.approvalSourceId
        })
        .from(routines)
        .where(and(eq(routines.id, routineId), eq(routines.userId, ownerId)))
        .limit(1)
      if (routine === undefined) throw new Error("Routine does not belong to the owner")
      if (routine.approvalSourceId === "legacy-unverified")
        throw new Error("Routine approval evidence is required")
      const evidence =
        routine.approvalSourceType === "owner_message"
          ? await database
              .select({ id: messages.id })
              .from(messages)
              .where(
                and(
                  eq(messages.id, routine.approvalSourceId),
                  eq(messages.userId, ownerId),
                  eq(messages.direction, "inbound")
                )
              )
              .limit(1)
          : await database
              .select({ id: trainingProposals.id })
              .from(trainingProposals)
              .where(
                and(
                  eq(trainingProposals.id, routine.approvalSourceId),
                  eq(trainingProposals.userId, ownerId),
                  eq(trainingProposals.toolName, "routine_save"),
                  eq(trainingProposals.status, "applied")
                )
              )
              .limit(1)
      if (evidence[0] === undefined) throw new Error("Routine approval evidence is required")
      if (gymId !== undefined) {
        const [gym] = await database
          .select({ id: gyms.id })
          .from(gyms)
          .where(and(eq(gyms.id, gymId), eq(gyms.userId, ownerId)))
          .limit(1)
        if (gym === undefined) throw new Error("Gym does not belong to the owner")
      }
      const id = randomUuid()
      const at = now().toISOString()
      try {
        await database.batch([
          database.insert(workoutSessions).values({
            id,
            userId: ownerId,
            routineId,
            gymId,
            status: "active",
            startedAt: at,
            createdAt: at
          }),
          completeEffect(database, effect, id, randomUuid(), at)
        ])
      } catch (error) {
        return completedEffectAfterConflict(database, effect, error)
      }
      return id
    },

    async logSet(ownerId, input, idempotencyKey) {
      const effect: EffectIdentity = { ownerId, kind: "workout_log_set", idempotencyKey }
      const previous = await completedEffect(database, effect)
      if (previous !== undefined) return { setId: previous, safetyStopped: false }
      if (
        input.sequence < 1 ||
        input.repetitions < 1 ||
        input.repetitions > 100 ||
        (input.weightGrams !== undefined &&
          (input.weightGrams < 0 || input.weightGrams > 2_000_000))
      ) {
        throw new Error("Workout set values are outside the safe bounds")
      }
      const [session] = await database
        .select()
        .from(workoutSessions)
        .where(
          and(
            eq(workoutSessions.id, input.sessionId),
            eq(workoutSessions.userId, ownerId),
            eq(workoutSessions.status, "active")
          )
        )
        .limit(1)
      if (session === undefined) throw new Error("Workout session is not active for the owner")
      const [step] = await database
        .select()
        .from(routineSteps)
        .where(
          and(
            eq(routineSteps.id, input.routineStepId),
            eq(routineSteps.routineId, session.routineId)
          )
        )
        .limit(1)
      if (step === undefined) throw new Error("Routine step does not belong to the workout")
      if (input.equipmentId !== undefined) {
        if (session.gymId === null) throw new Error("Workout has no gym for this equipment")
        const [mapping] = await database
          .select({ id: equipmentExercises.id })
          .from(equipmentExercises)
          .innerJoin(equipment, eq(equipmentExercises.equipmentId, equipment.id))
          .where(
            and(
              eq(equipment.id, input.equipmentId),
              eq(equipment.gymId, session.gymId),
              eq(equipmentExercises.exerciseId, step.exerciseId)
            )
          )
          .limit(1)
        if (mapping === undefined) throw new Error("Equipment is not approved for this exercise")
      }
      const id = randomUuid()
      const at = now().toISOString()
      try {
        await database.batch([
          database.insert(workoutSets).values({
            id,
            sessionId: input.sessionId,
            routineStepId: input.routineStepId,
            equipmentId: input.equipmentId,
            sequence: input.sequence,
            repetitions: input.repetitions,
            weightGrams: input.weightGrams,
            notes: input.notes,
            painReported: false,
            machineConfusion: false,
            loggedAt: at
          }),
          completeEffect(database, effect, id, randomUuid(), at)
        ])
      } catch (error) {
        const winner = await completedEffectAfterConflict(database, effect, error)
        return { setId: winner, safetyStopped: false }
      }
      return { setId: id, safetyStopped: false }
    },

    async finishWorkout(ownerId, sessionId, idempotencyKey) {
      const effect: EffectIdentity = { ownerId, kind: "workout_finish", idempotencyKey }
      if ((await completedEffect(database, effect)) !== undefined) return
      const at = now().toISOString()
      const [active] = await database
        .select({ id: workoutSessions.id })
        .from(workoutSessions)
        .where(
          and(
            eq(workoutSessions.id, sessionId),
            eq(workoutSessions.userId, ownerId),
            eq(workoutSessions.status, "active")
          )
        )
        .limit(1)
      if (active === undefined) throw new Error("Workout session is not active for the owner")
      try {
        await database.batch([
          database
            .update(workoutSessions)
            .set({ status: "completed", finishedAt: at })
            .where(
              and(
                eq(workoutSessions.id, sessionId),
                eq(workoutSessions.userId, ownerId),
                eq(workoutSessions.status, "active")
              )
            ),
          completeEffect(database, effect, sessionId, randomUuid(), at)
        ])
      } catch (error) {
        await completedEffectAfterConflict(database, effect, error)
      }
    },

    async stopActiveForSafety(ownerId, _signal, idempotencyKey) {
      const effect: EffectIdentity = { ownerId, kind: "workout_safety_stop", idempotencyKey }
      const previous = await completedEffect(database, effect)
      if (previous !== undefined) return previous === "none" ? undefined : previous
      const [session] = await database
        .select({ id: workoutSessions.id })
        .from(workoutSessions)
        .where(and(eq(workoutSessions.userId, ownerId), eq(workoutSessions.status, "active")))
        .orderBy(desc(workoutSessions.startedAt))
        .limit(1)
      const at = now().toISOString()
      const resultRef = session?.id ?? "none"
      try {
        if (session === undefined) {
          await database.batch([completeEffect(database, effect, resultRef, randomUuid(), at)])
        } else {
          await database.batch([
            database
              .update(workoutSessions)
              .set({ status: "stopped_for_safety", finishedAt: at })
              .where(
                and(
                  eq(workoutSessions.id, session.id),
                  eq(workoutSessions.userId, ownerId),
                  eq(workoutSessions.status, "active")
                )
              ),
            completeEffect(database, effect, resultRef, randomUuid(), at)
          ])
        }
      } catch (error) {
        const winner = await completedEffectAfterConflict(database, effect, error)
        return winner === "none" ? undefined : winner
      }
      return session?.id
    },

    async lastWorkout(ownerId, routineId) {
      const [session] = await database
        .select({ session: workoutSessions, routineName: routines.name })
        .from(workoutSessions)
        .innerJoin(routines, eq(workoutSessions.routineId, routines.id))
        .where(
          routineId === undefined
            ? and(eq(workoutSessions.userId, ownerId), eq(routines.userId, ownerId))
            : and(
                eq(workoutSessions.userId, ownerId),
                eq(workoutSessions.routineId, routineId),
                eq(routines.userId, ownerId)
              )
        )
        .orderBy(desc(workoutSessions.startedAt))
        .limit(1)
      if (session === undefined) return undefined
      const sets = await database
        .select({
          id: workoutSets.id,
          routineStepId: workoutSets.routineStepId,
          equipmentId: workoutSets.equipmentId,
          sequence: workoutSets.sequence,
          repetitions: workoutSets.repetitions,
          weightGrams: workoutSets.weightGrams,
          notes: workoutSets.notes,
          loggedAt: workoutSets.loggedAt
        })
        .from(workoutSets)
        .where(eq(workoutSets.sessionId, session.session.id))
        .orderBy(workoutSets.loggedAt)
      return {
        id: session.session.id,
        routineId: session.session.routineId,
        routineName: session.routineName,
        gymId: session.session.gymId,
        status: session.session.status,
        startedAt: session.session.startedAt,
        finishedAt: session.session.finishedAt,
        sets
      }
    },

    async history(ownerId, routineId) {
      return database
        .select()
        .from(workoutSessions)
        .where(
          routineId === undefined
            ? eq(workoutSessions.userId, ownerId)
            : and(eq(workoutSessions.userId, ownerId), eq(workoutSessions.routineId, routineId))
        )
        .orderBy(desc(workoutSessions.startedAt))
        .limit(20)
    },

    async overview(ownerId, query) {
      const normalizedQuery = query?.trim().toLocaleLowerCase("en") ?? ""
      if (normalizedQuery.length > 100) throw new Error("Training search is too long")
      const [
        gymRows,
        equipmentRows,
        exerciseRows,
        mappingRows,
        routineRows,
        stepRows,
        sessions,
        activeSessions
      ] = await Promise.all([
        database.select().from(gyms).where(eq(gyms.userId, ownerId)).orderBy(gyms.name),
        database
          .select({ item: equipment, gymName: gyms.name })
          .from(equipment)
          .innerJoin(gyms, eq(equipment.gymId, gyms.id))
          .where(eq(gyms.userId, ownerId))
          .orderBy(equipment.name),
        database
          .select()
          .from(exercises)
          .where(eq(exercises.userId, ownerId))
          .orderBy(exercises.name),
        database
          .select({
            equipmentId: equipmentExercises.equipmentId,
            exerciseId: equipmentExercises.exerciseId
          })
          .from(equipmentExercises)
          .innerJoin(equipment, eq(equipmentExercises.equipmentId, equipment.id))
          .innerJoin(gyms, eq(equipment.gymId, gyms.id))
          .innerJoin(exercises, eq(equipmentExercises.exerciseId, exercises.id))
          .where(and(eq(gyms.userId, ownerId), eq(exercises.userId, ownerId))),
        database
          .select()
          .from(routines)
          .where(eq(routines.userId, ownerId))
          .orderBy(desc(routines.updatedAt)),
        database
          .select({
            id: routineSteps.id,
            routineId: routineSteps.routineId,
            exerciseId: routineSteps.exerciseId,
            exerciseName: exercises.name,
            position: routineSteps.position,
            targetSets: routineSteps.targetSets,
            targetReps: routineSteps.targetReps,
            notes: routineSteps.notes
          })
          .from(routineSteps)
          .innerJoin(routines, eq(routineSteps.routineId, routines.id))
          .innerJoin(exercises, eq(routineSteps.exerciseId, exercises.id))
          .where(and(eq(routines.userId, ownerId), eq(exercises.userId, ownerId)))
          .orderBy(routineSteps.position),
        database
          .select({
            session: workoutSessions,
            routineName: routines.name,
            gymName: gyms.name
          })
          .from(workoutSessions)
          .innerJoin(routines, eq(workoutSessions.routineId, routines.id))
          .leftJoin(gyms, and(eq(workoutSessions.gymId, gyms.id), eq(gyms.userId, ownerId)))
          .where(and(eq(workoutSessions.userId, ownerId), eq(routines.userId, ownerId)))
          .orderBy(desc(workoutSessions.startedAt))
          .limit(20),
        database
          .select({ session: workoutSessions, routineName: routines.name })
          .from(workoutSessions)
          .innerJoin(routines, eq(workoutSessions.routineId, routines.id))
          .where(
            and(
              eq(workoutSessions.userId, ownerId),
              eq(workoutSessions.status, "active"),
              eq(routines.userId, ownerId)
            )
          )
          .orderBy(desc(workoutSessions.startedAt))
          .limit(1)
      ])

      const exerciseIdsByEquipment = new Map<string, string[]>()
      for (const mapping of mappingRows) {
        const values = exerciseIdsByEquipment.get(mapping.equipmentId) ?? []
        values.push(mapping.exerciseId)
        exerciseIdsByEquipment.set(mapping.equipmentId, values)
      }
      const equipmentByGym = new Map<
        string,
        {
          id: string
          name: string
          identifier: string | null
          exerciseIds: readonly string[]
        }[]
      >()
      for (const row of equipmentRows) {
        const values = equipmentByGym.get(row.item.gymId) ?? []
        values.push({
          id: row.item.id,
          name: row.item.name,
          identifier: row.item.identifier,
          exerciseIds: exerciseIdsByEquipment.get(row.item.id) ?? []
        })
        equipmentByGym.set(row.item.gymId, values)
      }
      const stepsByRoutine = new Map<
        string,
        RoutineView["steps"] extends readonly (infer T)[] ? T[] : never
      >()
      for (const step of stepRows) {
        const values = stepsByRoutine.get(step.routineId) ?? []
        values.push({
          id: step.id,
          exerciseId: step.exerciseId,
          exerciseName: step.exerciseName,
          position: step.position,
          targetSets: step.targetSets,
          targetReps: step.targetReps,
          notes: step.notes
        })
        stepsByRoutine.set(step.routineId, values)
      }
      const includesQuery = (...values: readonly (string | null)[]) =>
        normalizedQuery.length === 0 ||
        values.some((value) => value?.toLocaleLowerCase("en").includes(normalizedQuery) === true)
      const exerciseNames = new Map(exerciseRows.map((exercise) => [exercise.id, exercise.name]))
      const gymViews = gymRows
        .map((gym) => ({ id: gym.id, name: gym.name, equipment: equipmentByGym.get(gym.id) ?? [] }))
        .filter((gym) =>
          includesQuery(
            gym.name,
            ...gym.equipment.flatMap((item) => [
              item.name,
              item.identifier,
              ...item.exerciseIds.map((id) => exerciseNames.get(id) ?? "")
            ])
          )
        )
      const exerciseViews = exerciseRows
        .map((exercise) => ({
          id: exercise.id,
          name: exercise.name,
          instructions: exercise.instructions
        }))
        .filter((exercise) => includesQuery(exercise.name, exercise.instructions))
      const routineViews = routineRows
        .map((routine) => ({
          id: routine.id,
          name: routine.name,
          revision: routine.revision,
          steps: stepsByRoutine.get(routine.id) ?? []
        }))
        .filter((routine) =>
          includesQuery(routine.name, ...routine.steps.map((step) => step.exerciseName))
        )
      const history = sessions
        .filter((row) => row.session.status !== "active")
        .map((row) => ({
          id: row.session.id,
          routineId: row.session.routineId,
          routineName: row.routineName,
          gymId: row.session.gymId,
          gymName: row.gymName,
          status: row.session.status,
          startedAt: row.session.startedAt,
          finishedAt: row.session.finishedAt
        }))
      const active = activeSessions[0]
      let activeWorkout: WorkoutView | undefined
      if (active !== undefined) {
        const sets = await database
          .select({
            id: workoutSets.id,
            routineStepId: workoutSets.routineStepId,
            equipmentId: workoutSets.equipmentId,
            sequence: workoutSets.sequence,
            repetitions: workoutSets.repetitions,
            weightGrams: workoutSets.weightGrams,
            notes: workoutSets.notes,
            loggedAt: workoutSets.loggedAt
          })
          .from(workoutSets)
          .where(eq(workoutSets.sessionId, active.session.id))
          .orderBy(workoutSets.loggedAt)
        activeWorkout = {
          id: active.session.id,
          routineId: active.session.routineId,
          routineName: active.routineName,
          gymId: active.session.gymId,
          status: active.session.status,
          startedAt: active.session.startedAt,
          finishedAt: active.session.finishedAt,
          sets
        }
      }
      const overview = {
        gyms: gymViews,
        exercises: exerciseViews,
        routines: routineViews,
        history
      }
      return activeWorkout === undefined ? overview : { ...overview, activeWorkout }
    }
  }
}

export function trainingStoreLayer(store: TrainingStore) {
  return Layer.succeed(TrainingStore, store)
}
