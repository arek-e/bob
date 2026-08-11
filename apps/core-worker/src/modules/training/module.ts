import { Context, Layer } from "effect"

import type { TrainingProposalStore, TrainingProposalSummary } from "./proposal-store.ts"
import type { TrainingStore } from "./store.ts"

export interface TrainingModule extends TrainingStore {
  proposeTraining: TrainingProposalStore["propose"]
  listTrainingProposals(ownerId: string): Promise<readonly TrainingProposalSummary[]>
  approveTrainingProposal: TrainingProposalStore["approve"]
}

export const TrainingModule = Context.Service<TrainingModule>("bob/TrainingModule")

export function makeTrainingModule(
  training: TrainingStore,
  proposals: TrainingProposalStore
): TrainingModule {
  return {
    ...training,
    proposeTraining: proposals.propose,
    listTrainingProposals: proposals.list,
    approveTrainingProposal: proposals.approve
  }
}

export function trainingModuleLayer(module: TrainingModule) {
  return Layer.succeed(TrainingModule, module)
}
