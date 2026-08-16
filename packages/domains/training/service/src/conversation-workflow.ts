import type { ConversationWorkflowModule } from "@bob/core-types/runtime-module"

import type { TrainingModule } from "./module.ts"

import { trainingSafetyResponse, trainingSafetySignal } from "./rules.ts"

export function makeTrainingConversationWorkflow(
  training: TrainingModule
): ConversationWorkflowModule {
  return {
    id: "training-safety",
    async prepare(input) {
      const signal = trainingSafetySignal(input.policyText)
      if (signal === undefined) return undefined
      return {
        reasonCode: "safety_stop",
        async execute() {
          await training.stopActiveForSafety(
            input.ownerId,
            signal,
            `${input.actionIdempotencyScope}:safety-stop`
          )
          const text = trainingSafetyResponse(input.policyText)
          return text === undefined
            ? { reasonCode: "safety_stop", feature: "training" }
            : { text, reasonCode: "safety_stop", feature: "training" }
        }
      }
    }
  }
}
