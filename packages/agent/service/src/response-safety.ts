import { AgentArtifact } from "@bob/artifacts-types/artifact"
import {
  internalToolReferences,
  noSupportedRecordFallback,
  requiresPersonalGrounding,
  scanUnsafeOutput,
  type OutputValidationCode
} from "@bob/policy-types/output-safety"
import { ToolName, type ToolResult } from "@bob/tools-types/tools"
import { Schema } from "effect"

const NonEmptyText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8_000))
const ShortText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_200))
const maximumResponseSources = 24

export const StructuredAssistantResponse = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  responseText: ShortText,
  sourceIds: Schema.Array(NonEmptyText).check(Schema.isMaxLength(maximumResponseSources)),
  toolNames: Schema.Array(ToolName),
  conflict: Schema.Literals(["none", "disclosed"]),
  artifact: Schema.optionalKey(Schema.NullOr(AgentArtifact))
})

export type StructuredAssistantResponse = typeof StructuredAssistantResponse.Type
export { noSupportedRecordFallback, requiresPersonalGrounding }

export interface AssistantResponsePolicy {
  readonly maxResponseCharacters: number
  readonly approvedSourceIds: ReadonlySet<string>
  readonly requiresSource?: boolean
  readonly conflictingSourceIds: ReadonlySet<string>
  readonly registeredToolNames?: ReadonlySet<string>
  readonly executedToolNames: ReadonlySet<string>
  readonly confirmedActionToolNames: ReadonlySet<string>
  readonly proposedActionToolNames?: ReadonlySet<string>
  readonly unknownActionToolNames: ReadonlySet<string>
}

export type AssistantResponseValidation =
  | { readonly ok: true; readonly value: StructuredAssistantResponse }
  | { readonly ok: false; readonly code: OutputValidationCode }

export function toolResultConfirmsAction(result: ToolResult): boolean {
  return result.evidence?.actionOutcome === "confirmed"
}

export interface TrustedToolSource {
  readonly sourceId: string
  readonly sourceLabel: string
  readonly occurredAt?: string
}

export function trustedToolSourcesFromResult(result: ToolResult): readonly TrustedToolSource[] {
  return result.evidence?.sources ?? []
}

export function deterministicToolResultFallback(
  results: readonly ToolResult[],
  maxResponseCharacters: number
): string | undefined {
  const result = results.at(-1)
  if (result?.evidence?.responseText !== undefined) {
    const response = result.evidence.responseText
    const hasEvidence =
      result.evidence.actionOutcome !== undefined || (result.evidence.sources?.length ?? 0) > 0
    const unsafe =
      scanUnsafeOutput(response) !== undefined || internalToolReferences(response).length > 0
    return hasEvidence && !unsafe && response.length <= maxResponseCharacters ? response : undefined
  }
  if (results.some((candidate) => !candidate.ok)) {
    const response = "I could not complete that request safely. Open Bob to review the result."
    return response.length <= maxResponseCharacters ? response : undefined
  }
  if (result === undefined) return undefined
  const unsafe =
    scanUnsafeOutput(result.message) !== undefined ||
    internalToolReferences(result.message).length > 0
  const response = unsafe
    ? "I could not finish the assistant response. Open Bob to review the result."
    : `I could not finish the assistant response. ${result.message}`
  return response.length <= maxResponseCharacters ? response : undefined
}

const genericActionClaim =
  /\bI\s+(?:created|saved|updated|changed|started|finished|logged|cancelled|canceled|snoozed|completed|marked|added|deleted|removed|set|proposed|confirmed|corrected|acknowledged)\b|\bjag\s+(?:har\s+)?(?:skapade|skapat|ställde\s+in|ställt\s+in|lade\s+till|lagt\s+till|sparade|sparat|uppdaterade|uppdaterat|ändrade|ändrat|startade|startat|avslutade|avslutat|slutförde|slutfört|loggade|loggat|registrerade|registrerat|avbröt|avbrutit|tog\s+bort|tagit\s+bort|raderade|raderat|sköt\s+upp|skjutit\s+upp|senarelade|senarelagt|flyttade|flyttat|markerade|markerat|föreslog|föreslagit|bekräftade|bekräftat|rättade|rättat|korrigerade|korrigerat)\b/iu
const categoricalOutcome =
  /\b(?:failed|succeeded|completed|was|were|is|are)\s+(?:created|saved|updated|changed|started|finished|logged|cancelled|canceled|snoozed|completed|marked|added|deleted|removed|set|proposed|confirmed|corrected|acknowledged|failed|successful)\b|\b(?:creation|update|save|start|finish|logging|mapping|addition|acknowledgment|completion|snooze|cancellation|correction|proposal)\s+(?:failed|succeeded)\b|\b(?:är|blev)\s+(?:skapad|skapat|sparad|sparat|uppdaterad|uppdaterat|ändrad|ändrat|startad|startat|avslutad|avslutat|loggad|loggat|registrerad|registrerat|raderad|raderat|bekräftad|bekräftat)\b/iu
const uncertainOutcome =
  /\b(?:cannot|can't|could not|couldn't)\s+(?:confirm|determine|tell|verify|know)\b[^.]{0,120}\b(?:whether|if)\b|\bkan\s+inte\s+(?:bekräfta|avgöra|säga|verifiera|veta)\b[^.]{0,120}\b(?:om|huruvida)\b/iu
const conflictText =
  /\b(?:conflict|conflicting|inconsistent|disagree|cannot (?:tell|determine) which)\b|(?:konflikt|motstrid|kan inte avgöra)/iu

function hasCategoricalActionClaim(text: string): boolean {
  return text
    .split(/(?<=[.!?])\s+/u)
    .some(
      (sentence) =>
        !uncertainOutcome.test(sentence) &&
        (genericActionClaim.test(sentence) || categoricalOutcome.test(sentence))
    )
}

export function validateAssistantResponse(
  raw: string,
  policy: AssistantResponsePolicy
): AssistantResponseValidation {
  try {
    if (raw.length > 16_000) return { ok: false, code: "response_envelope_too_long" }
    const decoded = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(
      JSON.parse(raw)
    )
    if (Array.isArray(decoded)) return { ok: false, code: "malformed_response" }
    const keys = Object.keys(decoded).toSorted()
    const expected = ["conflict", "protocolVersion", "responseText", "sourceIds", "toolNames"]
    const withArtifact = [...expected, "artifact"].toSorted()
    if (
      !(
        (keys.length === expected.length && keys.every((key, index) => key === expected[index])) ||
        (keys.length === withArtifact.length &&
          keys.every((key, index) => key === withArtifact[index]))
      )
    ) {
      return { ok: false, code: "malformed_response" }
    }
    const value = Schema.decodeUnknownSync(StructuredAssistantResponse)(decoded)
    if (value.responseText.length > policy.maxResponseCharacters) {
      return { ok: false, code: "response_too_long" }
    }
    const unsafeOutput = scanUnsafeOutput(value.responseText)
    if (unsafeOutput !== undefined) return { ok: false, code: unsafeOutput }
    if (value.artifact !== undefined && value.artifact !== null) {
      const artifactText = [
        value.artifact.title,
        ...value.artifact.sections.flatMap((section) => [section.heading, ...section.items])
      ].join("\n")
      if (artifactText.length > 2_400) return { ok: false, code: "response_too_long" }
      const unsafeArtifact = scanUnsafeOutput(artifactText)
      if (unsafeArtifact !== undefined) return { ok: false, code: unsafeArtifact }
      if (internalToolReferences(artifactText, policy.registeredToolNames).length > 0) {
        return { ok: false, code: "invalid_tool_reference" }
      }
    }
    if (policy.requiresSource === true && value.sourceIds.length === 0) {
      return { ok: false, code: "source_required" }
    }
    if (value.sourceIds.some((sourceId) => !policy.approvedSourceIds.has(sourceId))) {
      return { ok: false, code: "invalid_source_reference" }
    }
    const responseToolNames = new Set(value.toolNames)
    if (
      responseToolNames.size !== value.toolNames.length ||
      responseToolNames.size !== policy.executedToolNames.size ||
      value.toolNames.some((name) => !policy.executedToolNames.has(name))
    ) {
      return { ok: false, code: "invalid_tool_reference" }
    }
    const textToolReferences = internalToolReferences(
      value.responseText,
      policy.registeredToolNames
    )
    if (textToolReferences.some((name) => !policy.executedToolNames.has(name))) {
      return { ok: false, code: "invalid_tool_reference" }
    }
    if (hasCategoricalActionClaim(value.responseText)) {
      if (policy.unknownActionToolNames.size > 0) {
        return { ok: false, code: "unknown_action_claim" }
      }
      if (
        policy.confirmedActionToolNames.size === 0 &&
        (policy.proposedActionToolNames?.size ?? 0) === 0
      ) {
        return { ok: false, code: "unverified_action_claim" }
      }
    }
    const citesConflict = value.sourceIds.some((sourceId) =>
      policy.conflictingSourceIds.has(sourceId)
    )
    if (value.conflict === "disclosed" && !citesConflict) {
      return { ok: false, code: "unsupported_conflict" }
    }
    if (
      citesConflict &&
      (value.conflict !== "disclosed" || !conflictText.test(value.responseText))
    ) {
      return { ok: false, code: "conflict_not_disclosed" }
    }
    return { ok: true, value }
  } catch {
    return { ok: false, code: "malformed_response" }
  }
}

export type RepairedAssistantResponse =
  | {
      readonly ok: true
      readonly value: StructuredAssistantResponse
      readonly repairAttempted: boolean
    }
  | {
      readonly ok: false
      readonly code: "invalid_output"
      readonly validationCode: OutputValidationCode | "repair_failed"
      readonly repairAttempted: boolean
    }

export async function validateAssistantResponseWithRepair(
  raw: string,
  policy: AssistantResponsePolicy,
  repair?: (validationCode: OutputValidationCode) => Promise<string>
): Promise<RepairedAssistantResponse> {
  const first = validateAssistantResponse(raw, policy)
  if (first.ok) return { ...first, repairAttempted: false }
  if (repair === undefined) {
    return { ok: false, code: "invalid_output", validationCode: first.code, repairAttempted: false }
  }
  try {
    const repaired = validateAssistantResponse(await repair(first.code), policy)
    return repaired.ok
      ? { ...repaired, repairAttempted: true }
      : { ok: false, code: "invalid_output", validationCode: repaired.code, repairAttempted: true }
  } catch {
    return {
      ok: false,
      code: "invalid_output",
      validationCode: "repair_failed",
      repairAttempted: true
    }
  }
}
