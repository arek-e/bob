import { ContextItem } from "@bob/contracts/agent"
import { ToolName } from "@bob/contracts/tools"
import { Schema } from "effect"

import { metricNames, type CandidateSet, type EvaluationSuite, type MetricName } from "./gate.ts"

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

const Thresholds = Schema.Struct({
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
})

const Request = Schema.Struct({
  sourceMessageId: Schema.String.check(Schema.isUUID()),
  localTime: IsoDateTime,
  timeZone: TimeZone,
  locale: Schema.optionalKey(Locale),
  hourCycle: Schema.optionalKey(Schema.Literals(["auto", "h12", "h23"])),
  userText: BoundedText,
  contextItems: Schema.Array(ContextItem)
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

const Expectation = Schema.Struct({
  tools: Schema.optionalKey(Schema.Array(ToolName)),
  toolArguments: Schema.optionalKey(Schema.Array(ToolArgumentExpectation)),
  responseMustContainAll: Schema.optionalKey(Schema.Array(NonEmptyString)),
  responseMustContainAny: Schema.optionalKey(Schema.Array(Schema.Array(NonEmptyString))),
  responseMustNotContain: Schema.optionalKey(Schema.Array(NonEmptyString)),
  claims: Schema.optionalKey(Schema.Array(Claim)),
  retrieval: Schema.optionalKey(Retrieval),
  conflictDisclosure: Schema.optionalKey(Schema.Boolean),
  structuredOutput: Schema.optionalKey(Schema.Literals(["valid", "rejected"]))
})

const GoldenCase = Schema.Struct({
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
  expected: Expectation
})

const EvaluationSuiteSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  suiteId: NonEmptyString,
  dataClass: Schema.Literal("synthetic"),
  thresholds: Thresholds,
  cases: Schema.Array(GoldenCase)
})

const ToolCall = Schema.Struct({
  name: ToolName,
  arguments: JsonObject
})

const Candidate = Schema.Struct({
  caseId: NonEmptyString,
  responseText: Schema.String.check(Schema.isMaxLength(4_000)),
  toolCalls: Schema.Array(ToolCall),
  retrievedRecordIds: Schema.Array(NonEmptyString),
  claims: Schema.Array(Claim),
  structuredOutput: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(16_000))),
  conflictDisclosed: Schema.optionalKey(Schema.Boolean)
})

const CandidateSetSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  suiteId: NonEmptyString,
  dataClass: Schema.Literal("synthetic"),
  candidates: Schema.Array(Candidate)
})

function hasDuplicates(values: readonly string[]): boolean {
  return new Set(values).size !== values.length
}

function comparisonsAreValid(
  thresholds: Readonly<Record<MetricName, { readonly comparison: "min" | "max" }>>
): boolean {
  return metricNames.every((name) =>
    name === "staleLeakRate"
      ? thresholds[name].comparison === "max"
      : thresholds[name].comparison === "min"
  )
}

function thresholdsAreStrict(
  thresholds: Readonly<Record<MetricName, { readonly value: number }>>
): boolean {
  return metricNames.every((name) => thresholds[name].value === (name === "staleLeakRate" ? 0 : 1))
}

export function decodeEvaluationSuite(input: unknown): EvaluationSuite {
  try {
    const suite = Schema.decodeUnknownSync(EvaluationSuiteSchema)(input)
    if (suite.cases.length === 0) throw new Error("empty_suite")
    if (hasDuplicates(suite.cases.map((scenario) => scenario.id))) {
      throw new Error("duplicate_case")
    }
    if (!comparisonsAreValid(suite.thresholds)) throw new Error("invalid_comparison")
    if (!thresholdsAreStrict(suite.thresholds)) throw new Error("weakened_threshold")
    return suite as EvaluationSuite
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
