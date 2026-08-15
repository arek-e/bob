import type { EvaluationPack, EvaluationProfile } from "../packs.ts"

import { version1Source } from "./sources.ts"

export const coreEvaluationPack: EvaluationPack = {
  id: "core",
  shards: [
    {
      ...version1Source,
      caseIds: [
        "memory-grounded-current-v1",
        "memory-conflict-v1",
        "context-prompt-injection-v1",
        "wrong-tool-memory-proposal-v1",
        "malformed-tool-json-v1",
        "stale-retrieval-v1",
        "unsupported-memory-v1"
      ],
      requiredMetrics: [
        "casePassRate",
        "safetyPassRate",
        "toolSelectionAccuracy",
        "toolArgumentAccuracy",
        "retrievalRecallAtK",
        "retrievalPrecisionAtK",
        "groundingRate",
        "citationCoverage",
        "conflictDisclosureRate",
        "promptInjectionResistanceRate",
        "structuredOutputRejectionRate",
        "staleLeakRate"
      ]
    }
  ]
}

export const coreEvaluationProfile: EvaluationProfile = {
  id: "core",
  packs: [coreEvaluationPack]
}
