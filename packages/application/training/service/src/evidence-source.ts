import type { CoreDatabase } from "@bob/db-types"
import type { EvidenceSourceAdapter } from "@bob/memory-types/evidence"
import type { DataProtection } from "@bob/policy-types/data-protection"

import {
  routineSteps,
  routines,
  workoutSessions,
  workoutSets
} from "@bob/db-service/schema/training"
import { evidenceDate } from "@bob/memory-service/evidence"
import { and, asc, eq } from "drizzle-orm"
import { Effect } from "effect"

export function makeTrainingEvidenceSource(
  database: CoreDatabase,
  protection: DataProtection
): EvidenceSourceAdapter {
  return {
    id: "training_evidence",
    sourceTypes: ["routine", "workout_session"],
    async verify(reference) {
      if (reference.sourceType === "routine") {
        const [record] = await Effect.runPromise(
          database
            .select({
              createdAt: routines.createdAt,
              revision: routines.revision,
              name: routines.name,
              approvedAt: routines.approvedAt
            })
            .from(routines)
            .where(and(eq(routines.id, reference.sourceId), eq(routines.userId, reference.ownerId)))
            .limit(1)
        )
        if (record === undefined) return undefined
        const steps = await Effect.runPromise(
          database
            .select({
              position: routineSteps.position,
              exerciseId: routineSteps.exerciseId,
              targetSets: routineSteps.targetSets,
              targetReps: routineSteps.targetReps,
              notes: routineSteps.notes
            })
            .from(routineSteps)
            .where(eq(routineSteps.routineId, reference.sourceId))
            .orderBy(asc(routineSteps.position))
        )
        return {
          sourceLabel: `Saved routine linked on ${evidenceDate(record.createdAt)}`,
          occurredAt: record.createdAt,
          contentHash: await protection.contentHash(JSON.stringify({ record, steps })),
          originClass: "system_record",
          sensitivity: "normal",
          confirmationAuthority: "completed_system_command",
          disclosure: "model_and_channel"
        }
      }
      const [record] = await Effect.runPromise(
        database
          .select({
            occurredAt: workoutSessions.startedAt,
            finishedAt: workoutSessions.finishedAt,
            routineId: workoutSessions.routineId,
            gymId: workoutSessions.gymId,
            status: workoutSessions.status
          })
          .from(workoutSessions)
          .where(
            and(
              eq(workoutSessions.id, reference.sourceId),
              eq(workoutSessions.userId, reference.ownerId),
              eq(workoutSessions.status, "completed")
            )
          )
          .limit(1)
      )
      if (record === undefined) return undefined
      const sets = await Effect.runPromise(
        database
          .select({
            routineStepId: workoutSets.routineStepId,
            equipmentId: workoutSets.equipmentId,
            sequence: workoutSets.sequence,
            repetitions: workoutSets.repetitions,
            weightGrams: workoutSets.weightGrams,
            notes: workoutSets.notes,
            loggedAt: workoutSets.loggedAt
          })
          .from(workoutSets)
          .where(eq(workoutSets.sessionId, reference.sourceId))
          .orderBy(asc(workoutSets.loggedAt), asc(workoutSets.sequence))
      )
      return {
        sourceLabel: `Workout record linked on ${evidenceDate(record.occurredAt)}`,
        occurredAt: record.occurredAt,
        contentHash: await protection.contentHash(JSON.stringify({ record, sets })),
        originClass: "system_record",
        sensitivity: "normal",
        confirmationAuthority: "completed_system_command",
        disclosure: "model_and_channel"
      }
    }
  }
}
