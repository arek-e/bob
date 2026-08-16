import { ContextItem, PriorToolReceipt } from "@bob/contracts/agent"
import { ToolName } from "@bob/contracts/tools"
import { Schema } from "effect"

import { metricNames, strictThreshold, version1MetricNames, type MetricName } from "./metrics.ts"

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

const ThresholdSchema = Schema.Struct({
  comparison: Schema.Literals(["min", "max"]),
  value: Rate
})

const Version1ThresholdFields = {
  casePassRate: ThresholdSchema,
  safetyPassRate: ThresholdSchema,
  toolSelectionAccuracy: ThresholdSchema,
  toolArgumentAccuracy: ThresholdSchema,
  retrievalRecallAtK: ThresholdSchema,
  retrievalPrecisionAtK: ThresholdSchema,
  groundingRate: ThresholdSchema,
  citationCoverage: ThresholdSchema,
  conflictDisclosureRate: ThresholdSchema,
  promptInjectionResistanceRate: ThresholdSchema,
  structuredOutputRejectionRate: ThresholdSchema,
  staleLeakRate: ThresholdSchema
} as const

const InteractionThresholdFields = {
  clarificationPrecision: ThresholdSchema,
  clarificationRecall: ThresholdSchema,
  correctionRecoveryTurns: ThresholdSchema,
  preferenceChangeRecoveryRate: ThresholdSchema,
  stalePreferenceUseRate: ThresholdSchema,
  proactivePrecision: ThresholdSchema,
  proactiveRecall: ThresholdSchema,
  unnecessaryInterruptionRate: ThresholdSchema,
  externalGroundingRate: ThresholdSchema,
  unknownOutcomeDisclosureRate: ThresholdSchema,
  reversibleActionSuccessRate: ThresholdSchema
} as const

const Version1Thresholds = Schema.Struct(Version1ThresholdFields)
const Version2Thresholds = Schema.Struct({
  ...Version1ThresholdFields,
  ...InteractionThresholdFields
})

const EvaluationRequestSchema = Schema.Struct({
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
  externalGrounding: Schema.optionalKey(
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

const Version1GoldenCaseSchema = Schema.Struct({
  id: NonEmptyString,
  category: NonEmptyString,
  safetyCritical: Schema.Boolean,
  liveEligible: Schema.Boolean,
  request: EvaluationRequestSchema,
  expected: Version1Expectation
})

const Version2GoldenCaseSchema = Schema.Struct({
  id: NonEmptyString,
  category: NonEmptyString,
  safetyCritical: Schema.Boolean,
  liveEligible: Schema.Boolean,
  request: EvaluationRequestSchema,
  expected: Version2Expectation
})

export const Version1EvaluationSuiteSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  suiteId: NonEmptyString,
  dataClass: Schema.Literal("synthetic"),
  thresholds: Version1Thresholds,
  requiredMetrics: Schema.optionalKey(Schema.Array(Schema.Literals(version1MetricNames))),
  cases: Schema.Array(Version1GoldenCaseSchema)
})

export const Version2EvaluationSuiteSchema = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  suiteId: NonEmptyString,
  dataClass: Schema.Literal("synthetic"),
  thresholds: Version2Thresholds,
  requiredMetrics: Schema.optionalKey(Schema.Array(Schema.Literals(metricNames))),
  cases: Schema.Array(Version2GoldenCaseSchema)
})

export const EvaluationSuiteSchema = Schema.Union([
  Version1EvaluationSuiteSchema,
  Version2EvaluationSuiteSchema
])

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
  externalSourceIds: Schema.optionalKey(Schema.Array(NonEmptyString)),
  unknownOutcomeDisclosed: Schema.optionalKey(Schema.Boolean),
  reversibleActionSucceeded: Schema.optionalKey(Schema.Boolean)
})

const Version1CandidateSchema = Schema.Struct(Version1CandidateFields)
const Version2CandidateSchema = Schema.Struct({
  ...Version1CandidateFields,
  interaction: Schema.optionalKey(InteractionObservation)
})

export const Version1CandidateSetSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  suiteId: NonEmptyString,
  dataClass: Schema.Literal("synthetic"),
  candidates: Schema.Array(Version1CandidateSchema)
})

export const Version2CandidateSetSchema = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  suiteId: NonEmptyString,
  dataClass: Schema.Literal("synthetic"),
  candidates: Schema.Array(Version2CandidateSchema)
})

export const CandidateSetSchema = Schema.Union([
  Version1CandidateSetSchema,
  Version2CandidateSetSchema
])

export type Threshold = typeof ThresholdSchema.Type
export type EvaluationRequest = typeof EvaluationRequestSchema.Type
export type ToolArgumentExpectation = typeof ToolArgumentExpectation.Type
export type ClaimExpectation = typeof Claim.Type
export type RetrievalExpectation = typeof Retrieval.Type
export type InteractionExpectation = typeof InteractionExpectation.Type
export type Version1CaseExpectation = typeof Version1Expectation.Type
export type Version2CaseExpectation = typeof Version2Expectation.Type
export type CaseExpectation = Version1CaseExpectation | Version2CaseExpectation
export type Version1GoldenCase = typeof Version1GoldenCaseSchema.Type
export type Version2GoldenCase = typeof Version2GoldenCaseSchema.Type
export type GoldenCase = Version1GoldenCase | Version2GoldenCase
export type Version1EvaluationSuite = typeof Version1EvaluationSuiteSchema.Type
export type Version2EvaluationSuite = typeof Version2EvaluationSuiteSchema.Type
export type EvaluationSuite = typeof EvaluationSuiteSchema.Type
export type ToolCallObservation = typeof ToolCall.Type
export type ClaimObservation = typeof Claim.Type
export type InteractionObservation = typeof InteractionObservation.Type
export type Version1CandidateObservation = typeof Version1CandidateSchema.Type
export type Version2CandidateObservation = typeof Version2CandidateSchema.Type
export type CandidateObservation = Version1CandidateObservation | Version2CandidateObservation
export type Version1CandidateSet = typeof Version1CandidateSetSchema.Type
export type Version2CandidateSet = typeof Version2CandidateSetSchema.Type
export type CandidateSet = typeof CandidateSetSchema.Type

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

export function decodeEvaluationSuite<Input>(input: Input): EvaluationSuite {
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
    if (suite.requiredMetrics !== undefined && hasDuplicates(suite.requiredMetrics)) {
      throw new Error("duplicate_required_metric")
    }
    return suite
  } catch {
    throw new Error("invalid_evaluation_suite")
  }
}

export function decodeCandidateSet<Input>(input: Input): CandidateSet {
  try {
    const candidates = Schema.decodeUnknownSync(CandidateSetSchema)(input)
    if (hasDuplicates(candidates.candidates.map((candidate) => candidate.caseId))) {
      throw new Error("duplicate_candidate")
    }
    return candidates
  } catch {
    throw new Error("invalid_candidate_set")
  }
}
