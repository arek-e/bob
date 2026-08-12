import { ContextItem, PriorToolReceipt } from "@bob/contracts/agent"
import { ToolName } from "@bob/contracts/tools"
import { Schema } from "effect"

import {
  metricNames,
  strictThreshold,
  version1MetricNames,
  type CandidateSet,
  type EvaluationSuite,
  type MetricName,
  type Threshold
} from "./gate.ts"

const NonEmptyString = Schema.String.check(Schema.isMinLength(1))
const BoundedText = NonEmptyString.check(Schema.isMaxLength(4_000))
const JsonObject = Schema.Record(Schema.String, Schema.Json)
const Rate = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))
const IsoDateTime = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/)
)
const TimeZone = Schema.String.check(Schema.isPattern(/^(?:UTC|[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+)$/))
const Locale = Schema.String.check(
  Schema.isMinLength(2),
  Schema.isMaxLength(64),
  Schema.isPattern(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/)
)

const Threshold = Schema.Struct({
  comparison: Schema.Literals(["min", "max"]),
  value: Rate
})

const Version1ThresholdFields = {
  casePassRate: Threshold,
  safetyPassRate: Threshold,
  toolSelectionAccuracy: Threshold,
  toolArgumentAccuracy: Threshold,
  retrievalRecallAtK: Threshold,
  retrievalPrecisionAtK: Threshold,
  groundingRate: Threshold,
  citationCoverage: Threshold,
  conflictDisclosureRate: Threshold,
  promptInjectionResistanceRate: Threshold,
  trainingSafetyRate: Threshold,
  structuredOutputRejectionRate: Threshold,
  staleLeakRate: Threshold
} as const

const InteractionThresholdFields = {
  clarificationPrecision: Threshold,
  clarificationRecall: Threshold,
  correctionRecoveryTurns: Threshold,
  preferenceChangeRecoveryRate: Threshold,
  stalePreferenceUseRate: Threshold,
  proactivePrecision: Threshold,
  proactiveRecall: Threshold,
  unnecessaryInterruptionRate: Threshold,
  connectorGroundedActionRate: Threshold,
  unknownOutcomeDisclosureRate: Threshold,
  undoCancellationSuccessRate: Threshold
} as const

const Version1Thresholds = Schema.Struct(Version1ThresholdFields)
const Version2Thresholds = Schema.Struct({
  ...Version1ThresholdFields,
  ...InteractionThresholdFields
})

const Request = Schema.Struct({
  sourceMessageId: Schema.String.check(Schema.isUUID()),
  localTime: IsoDateTime,
  timeZone: TimeZone,
  locale: Schema.optionalKey(Locale),
  hourCycle: Schema.optionalKey(Schema.Literals(["auto", "h12", "h23"])),
  trigger: Schema.optionalKey(Schema.Literals(["owner_message", "scheduled_signal"])),
  userText: BoundedText,
  contextItems: Schema.Array(ContextItem),
  priorToolReceipts: Schema.optionalKey(Schema.Array(PriorToolReceipt).check(Schema.isMaxLength(8)))
})

const ToolArgumentExpectation = Schema.Struct({
  tool: ToolName,
  values: JsonObject
})

const Claim = Schema.Struct({
  claimId: NonEmptyString,
  supportingRecordIds: Schema.Array(NonEmptyString),
  sourceLabels: Schema.Array(NonEmptyString)
})

const Retrieval = Schema.Struct({
  relevantRecordIds: Schema.Array(NonEmptyString),
  excludedRecordIds: Schema.Array(NonEmptyString),
  atK: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 }))
})

const Version1ExpectationFields = {
  tools: Schema.optionalKey(Schema.Array(ToolName)),
  toolArguments: Schema.optionalKey(Schema.Array(ToolArgumentExpectation)),
  responseMustContainAll: Schema.optionalKey(Schema.Array(NonEmptyString)),
  responseMustContainAny: Schema.optionalKey(Schema.Array(Schema.Array(NonEmptyString))),
  responseMustNotContain: Schema.optionalKey(Schema.Array(NonEmptyString)),
  claims: Schema.optionalKey(Schema.Array(Claim)),
  retrieval: Schema.optionalKey(Retrieval),
  conflictDisclosure: Schema.optionalKey(Schema.Boolean),
  structuredOutput: Schema.optionalKey(Schema.Literals(["valid", "rejected"]))
} as const

const InteractionExpectation = Schema.Struct({
  clarification: Schema.optionalKey(Schema.Literals(["required", "not_required"])),
  correctionRecovery: Schema.optionalKey(
    Schema.Struct({
      maxTurns: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 }))
    })
  ),
  preferenceChange: Schema.optionalKey(
    Schema.Struct({
      currentRecordId: NonEmptyString,
      staleRecordIds: Schema.Array(NonEmptyString).check(Schema.isMinLength(1))
    })
  ),
  proactive: Schema.optionalKey(Schema.Literals(["required", "not_required"])),
  connectorGrounding: Schema.optionalKey(
    Schema.Struct({
      requiredSourceIds: Schema.Array(NonEmptyString).check(Schema.isMinLength(1))
    })
  ),
  unknownOutcomeDisclosure: Schema.optionalKey(Schema.Literal("required")),
  reversibleAction: Schema.optionalKey(Schema.Literals(["undo", "cancel"]))
})

const Version1Expectation = Schema.Struct(Version1ExpectationFields)
const Version2Expectation = Schema.Struct({
  ...Version1ExpectationFields,
  interaction: Schema.optionalKey(InteractionExpectation)
})

const Version1GoldenCase = Schema.Struct({
  id: NonEmptyString,
  category: Schema.Literals([
    "reminder_datetime",
    "memory_grounding",
    "prompt_injection",
    "training_safety",
    "tool_selection",
    "structured_output",
    "stale_retrieval"
  ]),
  safetyCritical: Schema.Boolean,
  liveEligible: Schema.Boolean,
  request: Request,
  expected: Version1Expectation
})

const Version2GoldenCase = Schema.Struct({
  id: NonEmptyString,
  category: Schema.Literals([
    "reminder_datetime",
    "memory_grounding",
    "prompt_injection",
    "training_safety",
    "tool_selection",
    "structured_output",
    "stale_retrieval",
    "reminder_clarification",
    "connector_grounding",
    "correction_recovery",
    "preference_adaptation",
    "proactive_assistance",
    "action_recovery"
  ]),
  safetyCritical: Schema.Boolean,
  liveEligible: Schema.Boolean,
  request: Request,
  expected: Version2Expectation
})

const Version1EvaluationSuite = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  suiteId: NonEmptyString,
  dataClass: Schema.Literal("synthetic"),
  thresholds: Version1Thresholds,
  cases: Schema.Array(Version1GoldenCase)
})

const Version2EvaluationSuite = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  suiteId: NonEmptyString,
  dataClass: Schema.Literal("synthetic"),
  thresholds: Version2Thresholds,
  cases: Schema.Array(Version2GoldenCase)
})

const EvaluationSuiteSchema = Schema.Union([Version1EvaluationSuite, Version2EvaluationSuite])

const ToolCall = Schema.Struct({
  name: ToolName,
  arguments: JsonObject
})

const Version1CandidateFields = {
  caseId: NonEmptyString,
  responseText: Schema.String.check(Schema.isMaxLength(4_000)),
  toolCalls: Schema.Array(ToolCall),
  retrievedRecordIds: Schema.Array(NonEmptyString),
  claims: Schema.Array(Claim),
  structuredOutput: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(16_000))),
  conflictDisclosed: Schema.optionalKey(Schema.Boolean)
} as const

const InteractionObservation = Schema.Struct({
  clarificationAsked: Schema.optionalKey(Schema.Boolean),
  correctionRecoveryTurns: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 }))
  ),
  appliedPreferenceRecordIds: Schema.optionalKey(Schema.Array(NonEmptyString)),
  proactiveIntervention: Schema.optionalKey(Schema.Boolean),
  connectorSourceIds: Schema.optionalKey(Schema.Array(NonEmptyString)),
  unknownOutcomeDisclosed: Schema.optionalKey(Schema.Boolean),
  reversibleActionSucceeded: Schema.optionalKey(Schema.Boolean)
})

const Version1Candidate = Schema.Struct(Version1CandidateFields)
const Version2Candidate = Schema.Struct({
  ...Version1CandidateFields,
  interaction: Schema.optionalKey(InteractionObservation)
})

const Version1CandidateSet = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  suiteId: NonEmptyString,
  dataClass: Schema.Literal("synthetic"),
  candidates: Schema.Array(Version1Candidate)
})

const Version2CandidateSet = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  suiteId: NonEmptyString,
  dataClass: Schema.Literal("synthetic"),
  candidates: Schema.Array(Version2Candidate)
})

const CandidateSetSchema = Schema.Union([Version1CandidateSet, Version2CandidateSet])

function hasDuplicates(values: readonly string[]): boolean {
  return new Set(values).size !== values.length
}

function comparisonsAreValid(
  thresholds: Readonly<Partial<Record<MetricName, { readonly comparison: "min" | "max" }>>>,
  names: readonly MetricName[]
): boolean {
  return names.every((name) => thresholds[name]?.comparison === strictThreshold(name).comparison)
}

function thresholdsAreStrict(
  thresholds: Readonly<Partial<Record<MetricName, { readonly value: number }>>>,
  names: readonly MetricName[]
): boolean {
  return names.every((name) => thresholds[name]?.value === strictThreshold(name).value)
}

function hasVersion2Coverage(suite: typeof Version2EvaluationSuite.Type): boolean {
  const interactions = suite.cases.flatMap((scenario) =>
    scenario.expected.interaction === undefined ? [] : [scenario.expected.interaction]
  )
  return (
    interactions.some((value) => value.clarification === "required") &&
    interactions.some((value) => value.clarification === "not_required") &&
    interactions.some((value) => value.correctionRecovery !== undefined) &&
    interactions.some((value) => value.preferenceChange !== undefined) &&
    interactions.some((value) => value.proactive === "required") &&
    interactions.some((value) => value.proactive === "not_required") &&
    interactions.some((value) => value.connectorGrounding !== undefined) &&
    interactions.some((value) => value.unknownOutcomeDisclosure === "required") &&
    interactions.some((value) => value.reversibleAction === "undo") &&
    interactions.some((value) => value.reversibleAction === "cancel")
  )
}

export function decodeEvaluationSuite(input: unknown): EvaluationSuite {
  try {
    const suite = Schema.decodeUnknownSync(EvaluationSuiteSchema)(input)
    if (suite.cases.length === 0) throw new Error("empty_suite")
    if (hasDuplicates(suite.cases.map((scenario) => scenario.id))) {
      throw new Error("duplicate_case")
    }
    const activeMetricNames = suite.schemaVersion === 1 ? version1MetricNames : metricNames
    if (!comparisonsAreValid(suite.thresholds, activeMetricNames)) {
      throw new Error("invalid_comparison")
    }
    if (!thresholdsAreStrict(suite.thresholds, activeMetricNames)) {
      throw new Error("weakened_threshold")
    }
    if (suite.schemaVersion === 2 && !hasVersion2Coverage(suite)) {
      throw new Error("incomplete_interaction_coverage")
    }
    const suiteThresholds = suite.thresholds as Readonly<Partial<Record<MetricName, Threshold>>>
    const thresholds = Object.fromEntries(
      metricNames.map((name) => [name, suiteThresholds[name] ?? strictThreshold(name)])
    )
    return { ...suite, thresholds } as EvaluationSuite
  } catch {
    throw new Error("invalid_evaluation_suite")
  }
}

export function decodeCandidateSet(input: unknown): CandidateSet {
  try {
    const candidates = Schema.decodeUnknownSync(CandidateSetSchema)(input)
    if (hasDuplicates(candidates.candidates.map((candidate) => candidate.caseId))) {
      throw new Error("duplicate_candidate")
    }
    return candidates as CandidateSet
  } catch {
    throw new Error("invalid_candidate_set")
  }
}
