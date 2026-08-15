import type { EvaluationProfile } from "../packs.ts"

import { coreEvaluationPack } from "./core.ts"
import {
  connectionsEvaluationPack,
  reminderEvaluationPack,
  trainingEvaluationPack
} from "./optional.ts"

export const transitionalEvaluationProfile: EvaluationProfile = {
  id: "transitional",
  packs: [
    coreEvaluationPack,
    reminderEvaluationPack,
    trainingEvaluationPack,
    connectionsEvaluationPack
  ]
}
