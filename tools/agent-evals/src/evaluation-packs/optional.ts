import type { EvaluationPack } from "../packs.ts"

import { version1Source, version2Source } from "./sources.ts"

export const reminderEvaluationPack: EvaluationPack = {
  id: "reminders",
  shards: [
    {
      ...version1Source,
      caseIds: ["reminder-tomorrow-dst-v1", "reminder-absolute-evening-v1"],
      requiredMetrics: ["casePassRate", "toolSelectionAccuracy", "toolArgumentAccuracy"]
    },
    {
      ...version2Source,
      caseIds: [
        "reminder-clarification-required-v2",
        "reminder-clarification-not-required-v2",
        "reminder-correction-recovery-v2",
        "reminder-undo-v2",
        "reminder-cancel-v2",
        "duplicate-action-prevention-v2"
      ],
      requiredMetrics: [
        "casePassRate",
        "safetyPassRate",
        "toolSelectionAccuracy",
        "clarificationPrecision",
        "clarificationRecall",
        "correctionRecoveryTurns",
        "reversibleActionSuccessRate"
      ]
    }
  ]
}

export const trainingEvaluationPack: EvaluationPack = {
  id: "training",
  shards: [
    {
      ...version1Source,
      caseIds: ["training-pain-stop-v1", "wrong-tool-last-workout-v1"],
      requiredMetrics: ["casePassRate", "safetyPassRate", "toolSelectionAccuracy"]
    },
    {
      ...version2Source,
      caseIds: ["preference-change-recovery-v2"],
      requiredMetrics: [
        "casePassRate",
        "toolSelectionAccuracy",
        "retrievalRecallAtK",
        "retrievalPrecisionAtK",
        "groundingRate",
        "citationCoverage",
        "preferenceChangeRecoveryRate",
        "stalePreferenceUseRate"
      ]
    }
  ]
}

export const connectionsEvaluationPack: EvaluationPack = {
  id: "connections",
  shards: [
    {
      ...version2Source,
      caseIds: [
        "proactive-calendar-conflict-v2",
        "proactive-correct-silence-v2",
        "connector-grounded-selection-v2",
        "connector-revoked-access-v2",
        "connector-unknown-outcome-v2"
      ],
      requiredMetrics: [
        "casePassRate",
        "safetyPassRate",
        "toolSelectionAccuracy",
        "proactivePrecision",
        "proactiveRecall",
        "unnecessaryInterruptionRate",
        "externalGroundingRate",
        "unknownOutcomeDisclosureRate"
      ]
    }
  ]
}
