import type { ToolCommandAdapter, ToolCommandAdapterContext } from "@bob/tools-types/adapter"

import { jsonObject } from "@bob/shared-types/json"
import { fromPromiseToolExecution } from "@bob/tools-service/adapter"
import { capabilityToolNames } from "@bob/tools-types/tools"
import { type ToolResult } from "@bob/tools-types/tools"
import {
  RoutineGetArguments,
  trainingCapability,
  TrainingLookupArguments,
  WorkoutHistoryArguments
} from "@bob/training-types/capability"
import { Schema } from "effect"

import type { TrainingModule } from "./module.ts"

import { isTrainingMutationTool } from "./proposal-store.ts"
import { isTrainingMutationRequest } from "./rules.ts"

export function makeTrainingToolAdapter(training: TrainingModule): ToolCommandAdapter {
  return {
    capabilityId: trainingCapability.id,
    names: capabilityToolNames(trainingCapability),
    execute({ command, run }: ToolCommandAdapterContext) {
      return fromPromiseToolExecution(trainingCapability.id, async (): Promise<ToolResult> => {
        if (isTrainingMutationTool(command.name)) {
          if (!isTrainingMutationRequest(run.userText)) {
            return {
              ok: false,
              code: "approval_required",
              message: "Use an affirmative command, then approve the exact proposal in Bob."
            }
          }
          const proposal = await training.proposeTraining({
            ownerId: command.ownerId,
            runId: command.runId,
            toolCallId: command.toolCallId,
            toolName: command.name,
            commandIdempotencyKey: command.idempotencyKey,
            arguments: command.arguments,
            sourceMessageId: run.messageId
          })
          return {
            ok: true,
            code: "training_proposed",
            message: "Review this training change in Bob before it is applied.",
            evidence: { actionOutcome: "proposed" },
            data: {
              proposalId: proposal.id,
              proposalHash: proposal.proposalHash,
              status: proposal.status
            }
          }
        }

        switch (command.name) {
          case "gym_list": {
            const args = Schema.decodeUnknownSync(TrainingLookupArguments)(command.arguments)
            const overview = await training.overview(command.ownerId, args.query)
            const gyms = overview.gyms.slice(0, 100).map(({ id, name }) => ({ id, name }))
            return {
              ok: true,
              code: "gym_list",
              message: `${gyms.length} gyms found.`,
              data: jsonObject({ gyms })
            }
          }
          case "equipment_list": {
            const args = Schema.decodeUnknownSync(TrainingLookupArguments)(command.arguments)
            const overview = await training.overview(command.ownerId, args.query)
            const query = args.query?.trim().toLocaleLowerCase("en") ?? ""
            const matchingExerciseIds = new Set(overview.exercises.map((exercise) => exercise.id))
            const equipment = overview.gyms
              .flatMap((gym) =>
                gym.equipment.map((item) => ({
                  id: item.id,
                  name: item.name,
                  identifier: item.identifier,
                  gymId: gym.id,
                  gymName: gym.name,
                  exerciseIds: item.exerciseIds
                }))
              )
              .filter(
                (item) =>
                  query.length === 0 ||
                  item.name.toLocaleLowerCase("en").includes(query) ||
                  item.identifier?.toLocaleLowerCase("en").includes(query) === true ||
                  item.gymName.toLocaleLowerCase("en").includes(query) ||
                  item.exerciseIds.some((id) => matchingExerciseIds.has(id))
              )
              .slice(0, 100)
            return {
              ok: true,
              code: "equipment_list",
              message: `${equipment.length} equipment items found.`,
              data: jsonObject({ equipment })
            }
          }
          case "exercise_list": {
            const args = Schema.decodeUnknownSync(TrainingLookupArguments)(command.arguments)
            const overview = await training.overview(command.ownerId, args.query)
            const exercises = overview.exercises.slice(0, 100).map(({ id, name }) => ({ id, name }))
            return {
              ok: true,
              code: "exercise_list",
              message: `${exercises.length} exercises found.`,
              data: jsonObject({ exercises })
            }
          }
          case "routine_get": {
            const args = Schema.decodeUnknownSync(RoutineGetArguments)(command.arguments)
            const routine = await training.getRoutine(command.ownerId, args.id)
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
            const workout = await training.lastWorkout(command.ownerId, args.routineId)
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
            const history = await training.history(command.ownerId, args.routineId)
            return {
              ok: true,
              code: "workout_history",
              message: `${history.length} workouts found.`,
              data: jsonObject({ history })
            }
          }
          default:
            return {
              ok: false,
              code: "domain_error",
              message: "Bob could not complete this action safely."
            }
        }
      })
    }
  }
}
