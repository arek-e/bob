import { AgentArtifact } from "@bob/contracts/agent"
import {
  internalToolReferences,
  noSupportedRecordFallback,
  requiresPersonalGrounding,
  scanUnsafeOutput,
  type OutputValidationCode
} from "@bob/contracts/output-safety"
import { ToolName, type ToolResult } from "@bob/contracts/tools"
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
  readonly executedToolNames: ReadonlySet<string>
  readonly confirmedActionToolNames: ReadonlySet<string>
  readonly unknownActionToolNames: ReadonlySet<typeof ToolName.Type>
}

export type AssistantResponseValidation =
  | { readonly ok: true; readonly value: StructuredAssistantResponse }
  | { readonly ok: false; readonly code: OutputValidationCode }

interface ConfirmedActionCodesByTool extends Partial<
  Record<typeof ToolName.Type, ReadonlySet<string>>
> {}

const confirmedActionCodesByTool: ConfirmedActionCodesByTool = {
  reminder_create: new Set(["reminder_created", "reminder_exists"]),
  reminder_acknowledge: new Set(["reminder_seen"]),
  reminder_complete: new Set(["reminder_done"]),
  reminder_snooze: new Set(["reminder_snoozed"]),
  reminder_cancel: new Set(["reminder_cancelled", "reminder_occurrence_cancelled"]),
  memory_propose: new Set(["memory_proposed"]),
  journal_link_create: new Set(["journal_link_created"]),
  connection_link_create: new Set(["connection_link_created"]),
  settings_update: new Set(["owner_settings_updated"])
}

export function toolResultConfirmsAction(
  toolName: typeof ToolName.Type,
  result: ToolResult
): boolean {
  return result.ok && confirmedActionCodesByTool[toolName]?.has(result.code) === true
}

export interface TrustedToolSource {
  readonly sourceId: string
  readonly sourceLabel: string
  readonly occurredAt?: string
}

const TrustedToolSourceSchema = Schema.Struct({
  sourceId: NonEmptyText,
  sourceLabel: NonEmptyText,
  occurredAt: Schema.optionalKey(Schema.String)
})

export const emptyReminderListSource: TrustedToolSource = {
  sourceId: "bob:active-reminders",
  sourceLabel: "Bob active reminders"
}

export function emptyReminderListResponse(locale: string | undefined): string {
  return locale?.toLocaleLowerCase().startsWith("sv") === true
    ? "Du har inga aktiva påminnelser."
    : "You have no active reminders."
}

function trustedToolSource<Input>(value: Input): TrustedToolSource | undefined {
  try {
    return Schema.decodeUnknownSync(TrustedToolSourceSchema)(value)
  } catch {
    return undefined
  }
}

/** Only reviewed Core-returned records may extend response citations. */
export function trustedToolSourcesFromResult(
  result: ToolResult,
  toolName?: typeof ToolName.Type
): readonly TrustedToolSource[] {
  if (!result.ok || result.data === undefined) return []
  if (
    toolName === "reminder_list" &&
    result.code === "reminder_list" &&
    Array.isArray(result.data.reminders) &&
    result.data.reminders.length === 0
  ) {
    return [emptyReminderListSource]
  }
  if (result.code !== "memory_results") return []
  const matches = result.data.matches
  if (!Array.isArray(matches)) return []
  const sources = new Map<string, TrustedToolSource>()
  for (const match of matches) {
    const source = trustedToolSource(match)
    if (source !== undefined && !sources.has(source.sourceId)) {
      sources.set(source.sourceId, source)
    }
  }
  return [...sources.values()].slice(0, maximumResponseSources)
}

export function deterministicToolResultFallback(
  results: readonly ToolResult[],
  maxResponseCharacters: number
): string | undefined {
  if (results.some((result) => !result.ok)) {
    const response = "I could not complete that request safely. Open Bob to review the result."
    return response.length <= maxResponseCharacters ? response : undefined
  }
  const result = results.at(-1)
  if (result === undefined) return undefined
  const unsafe =
    scanUnsafeOutput(result.message) !== undefined ||
    internalToolReferences(result.message).length > 0
  const response = unsafe
    ? "I could not finish the assistant response. Open Bob to review the result."
    : `I could not finish the assistant response. ${result.message}`
  return response.length <= maxResponseCharacters ? response : undefined
}

const actionClaims: readonly {
  readonly pattern: RegExp
  readonly requiredTools: readonly (typeof ToolName.Type)[]
}[] = [
  {
    pattern:
      /\b(?:created|set|made)\b[^.]{0,80}\breminder\b|\breminder\b[^.]{0,80}\b(?:created|set)\b|\b(?:skapade|skapat|ställde\s+in|ställt\s+in|lade\s+till|lagt\s+till)\b[^.]{0,80}\bpåminnelse(?:n|r|rna)?\b|\bpåminnelse(?:n|r|rna)?\b[^.]{0,80}\b(?:skapad|skapats|inställd)\b/iu,
    requiredTools: ["reminder_create"]
  },
  {
    pattern:
      /\b(?:snoozed|rescheduled)\b[^.]{0,80}\breminder\b|\breminder\b[^.]{0,80}\bsnoozed\b|\b(?:sköt\s+upp|skjutit\s+upp|senarelade|senarelagt|flyttade|flyttat)\b[^.]{0,80}\bpåminnelse(?:n|r|rna)?\b|\bpåminnelse(?:n|r|rna)?\b[^.]{0,80}\b(?:uppskjuten|senarelagd|flyttad)\b/iu,
    requiredTools: ["reminder_snooze"]
  },
  {
    pattern:
      /\b(?:cancelled|canceled)\b[^.]{0,80}\breminder\b|\breminder\b[^.]{0,80}\b(?:cancelled|canceled)\b|\b(?:avbröt|avbrutit|tog\s+bort|tagit\s+bort|raderade|raderat)\b[^.]{0,80}\bpåminnelse(?:n|r|rna)?\b|\bpåminnelse(?:n|r|rna)?\b[^.]{0,80}\b(?:avbruten|borttagen|raderad)\b/iu,
    requiredTools: ["reminder_cancel"]
  },
  {
    pattern:
      /\bmarked\b[^.]{0,80}\breminder\b[^.]{0,40}\bseen\b|\breminder\b[^.]{0,80}\b(?:seen|acknowledged)\b|\bmarked (?:it |that )?as seen\b|\b(?:markerade|markerat)\b[^.]{0,80}\bpåminnelse(?:n|r|rna)?\b[^.]{0,40}\b(?:sedd|sett|bekräftad)\b|\bpåminnelse(?:n|r|rna)?\b[^.]{0,80}\b(?:sedd|sett|bekräftad)\b|\b(?:markerade|markerat)\s+(?:den|det)\s+som\s+(?:sedd|sett|bekräftad)\b/iu,
    requiredTools: ["reminder_acknowledge"]
  },
  {
    pattern:
      /\bmarked\b[^.]{0,80}\breminder\b[^.]{0,40}\b(?:done|complete)\b|\breminder\b[^.]{0,80}\b(?:done|completed)\b|\bmarked (?:it |that )?(?:done|complete)\b|\b(?:markerade|markerat)\b[^.]{0,80}\bpåminnelse(?:n|r|rna)?\b[^.]{0,40}\b(?:klar|klart|färdig|färdigt|slutförd)\b|\bpåminnelse(?:n|r|rna)?\b[^.]{0,80}\b(?:klar|färdig|slutförd)\b|\b(?:markerade|markerat)\s+(?:den|det)\s+som\s+(?:klar|klart|färdig|färdigt)\b/iu,
    requiredTools: ["reminder_complete"]
  },
  {
    pattern:
      /\b(?:created|made)\b[^.]{0,80}\bjournal link\b|\bjournal link\b[^.]{0,80}\bcreated\b|\b(?:skapade|skapat)\b[^.]{0,80}\b(?:journal|dagboks)länk(?:en)?\b|\b(?:journal|dagboks)länk(?:en)?\b[^.]{0,80}\b(?:skapad|skapats)\b|\b(?:skapade|skapat)\b[^.]{0,80}\blänk(?:en)?\s+till\s+(?:journalen|dagboken)\b/iu,
    requiredTools: ["journal_link_create"]
  },
  {
    pattern:
      /\b(?:created|made)\b[^.]{0,80}\b(?:calendar|account|connection)\s+link\b|\b(?:calendar|account|connection)\s+link\b[^.]{0,80}\bcreated\b|\b(?:skapade|skapat)\b[^.]{0,80}\b(?:kalender|konto|anslutnings)länk(?:en)?\b|\b(?:kalender|konto|anslutnings)länk(?:en)?\b[^.]{0,80}\b(?:skapad|skapats)\b/iu,
    requiredTools: ["connection_link_create"]
  },
  {
    pattern:
      /\bproposed\b[^.]{0,80}\bmemory\b|\bmemory\b[^.]{0,80}\bproposed\b|\b(?:föreslog|föreslagit)\b[^.]{0,80}\bminne(?:t)?\b|\bminne(?:t)?\b[^.]{0,80}\b(?:föreslaget|föreslagits)\b/iu,
    requiredTools: ["memory_propose"]
  },
  {
    pattern:
      /\bconfirmed\b[^.]{0,80}\bmemory\b|\bmemory\b[^.]{0,80}\bconfirmed\b|\b(?:bekräftade|bekräftat)\b[^.]{0,80}\bminne(?:t)?\b|\bminne(?:t)?\b[^.]{0,80}\bbekräftat\b/iu,
    requiredTools: ["memory_confirm"]
  },
  {
    pattern:
      /\b(?:saved|updated)\b[^.]{0,80}\broutine\b|\broutine\b[^.]{0,80}\b(?:saved|updated)\b|\b(?:sparade|sparat|uppdaterade|uppdaterat)\b[^.]{0,80}\b(?:rutin(?:en)?|träningsplan(?:en)?|träningsprogram(?:met)?)\b|\b(?:rutin(?:en)?|träningsplan(?:en)?|träningsprogram(?:met)?)\b[^.]{0,80}\b(?:sparad|uppdaterad)\b/iu,
    requiredTools: ["routine_save"]
  },
  {
    pattern:
      /\bstarted\b[^.]{0,80}\bworkout\b|\bworkout\b[^.]{0,80}\bstarted\b|\b(?:startade|startat)\b[^.]{0,80}\bträningspass(?:et)?\b|\bträningspass(?:et)?\b[^.]{0,80}\b(?:startat|startades)\b/iu,
    requiredTools: ["workout_start"]
  },
  {
    pattern:
      /\b(?:logged|recorded)\b[^.]{0,80}\bset\b|\b(?:loggade|loggat|registrerade|registrerat)\b[^.]{0,80}(?<![\p{L}\p{N}_])(?:set(?:et)?|övningsset(?:et)?)(?![\p{L}\p{N}_])|(?<![\p{L}\p{N}_])(?:set(?:et)?|övningsset(?:et)?)(?![\p{L}\p{N}_])[^.]{0,80}\b(?:loggat|registrerat)\b/iu,
    requiredTools: ["workout_log_set"]
  },
  {
    pattern:
      /\bfinished\b[^.]{0,80}\bworkout\b|\bworkout\b[^.]{0,80}\bfinished\b|\b(?:avslutade|avslutat|slutförde|slutfört)\b[^.]{0,80}\bträningspass(?:et)?\b|\bträningspass(?:et)?\b[^.]{0,80}\b(?:avslutat|slutfört)\b/iu,
    requiredTools: ["workout_finish"]
  },
  {
    pattern:
      /\b(?:saved|updated|changed)\b[^.]{0,80}\b(?:settings|time zone|locale|time format)\b|\b(?:sparade|sparat|uppdaterade|uppdaterat)\b[^.]{0,80}\b(?:inställning(?:en|ar|arna)?|tidszon(?:en)?|språk(?:et)?|tidsformat(?:et)?)\b|(?<![\p{L}\p{N}_])(?:ändrade|ändrat)(?![\p{L}\p{N}_])[^.]{0,80}\b(?:inställning(?:en|ar|arna)?|tidszon(?:en)?|språk(?:et)?|tidsformat(?:et)?)\b|\b(?:inställning(?:en|ar|arna)?|tidszon(?:en)?|språk(?:et)?|tidsformat(?:et)?)\b[^.]{0,80}(?<![\p{L}\p{N}_])(?:sparad|sparade|uppdaterad|ändrad|ändrats|uppdaterats)(?![\p{L}\p{N}_])/iu,
    requiredTools: ["settings_update"]
  }
]

function bidirectionalActionScope(subject: RegExp, action: RegExp): RegExp {
  const gap = String.raw`[^.!?;\n]{0,80}`
  return new RegExp(
    `(?:${action.source})${gap}(?:${subject.source})|(?:${subject.source})${gap}(?:${action.source})`,
    "iu"
  )
}

interface ActionScopeByTool extends Partial<Record<typeof ToolName.Type, RegExp>> {}

const actionScopeByTool: ActionScopeByTool = {
  reminder_create: bidirectionalActionScope(
    /\b(?:reminders?|påminnelse(?:n|r|rna)?)\b/u,
    /\b(?:creat(?:e|ed|ion)|set|made|skapa(?:de|t|nde)?|ställde?\s+in|ställt\s+in|lade\s+till|lagt\s+till)\b/u
  ),
  reminder_acknowledge: bidirectionalActionScope(
    /\b(?:reminders?|påminnelse(?:n|r|rna)?)\b/u,
    /\b(?:acknowledg(?:e|ed|ement|ment)|seen|mark(?:ed)?\s+(?:it\s+|that\s+)?as\s+seen|sedd|sett|bekräfta(?:d|de|t)?)\b/u
  ),
  reminder_complete: bidirectionalActionScope(
    /\b(?:reminders?|påminnelse(?:n|r|rna)?)\b/u,
    /\b(?:complet(?:e|ed|ion)|done|mark(?:ed)?\s+(?:it\s+|that\s+)?(?:done|complete)|klar|färdig|slutför(?:d|de|t)?)\b/u
  ),
  reminder_snooze: bidirectionalActionScope(
    /\b(?:reminders?|påminnelse(?:n|r|rna)?)\b/u,
    /\b(?:snooz(?:e|ed)|reschedul(?:e|ed|ing)|uppskjuten|senarelagd|flyttad)\b/u
  ),
  reminder_cancel: bidirectionalActionScope(
    /\b(?:reminders?|påminnelse(?:n|r|rna)?)\b/u,
    /\b(?:cancel(?:led|ed|lation)?|remov(?:e|ed)|delet(?:e|ed)|avbruten|borttagen|raderad)\b/u
  ),
  memory_propose: bidirectionalActionScope(
    /\b(?:memor(?:y|ies)|minne(?:t|n)?)\b/u,
    /\b(?:propos(?:e|ed|al)|föresl(?:å|og|agit|agen))\b/u
  ),
  memory_confirm: bidirectionalActionScope(
    /\b(?:memor(?:y|ies)|minne(?:t|n)?)\b/u,
    /\b(?:confirm(?:ed|ation)?|bekräfta(?:d|de|t)?)\b/u
  ),
  memory_correct: bidirectionalActionScope(
    /\b(?:memor(?:y|ies)|minne(?:t|n)?)\b/u,
    /\b(?:correct(?:ed|ion)?|korrigera(?:d|de|t)?|rätta(?:d|de|t)?)\b/u
  ),
  journal_link_create: bidirectionalActionScope(
    /\b(?:journal\s+links?|(?:journal|dagboks)länk(?:en)?)\b/u,
    /\b(?:creat(?:e|ed|ion)|made|skapa(?:d|de|t|nde)?)\b/u
  ),
  gym_create: bidirectionalActionScope(
    /\bgyms?\b/u,
    /\b(?:creat(?:e|ed|ion)|sav(?:e|ed|ing)|skapa(?:d|de|t|nde)?|spara(?:d|de|t|nde)?)\b/u
  ),
  exercise_create: bidirectionalActionScope(
    /\b(?:exercises?|övning(?:en|ar|arna)?)\b/u,
    /\b(?:creat(?:e|ed|ion)|propos(?:e|ed|al)|skapa(?:d|de|t|nde)?|föresl(?:å|og|agit|agen))\b/u
  ),
  gym_add_equipment: bidirectionalActionScope(
    /\b(?:equipment|utrustning(?:en)?)\b/u,
    /\b(?:add(?:ed|ition)?|sav(?:e|ed|ing)|tillagd|sparad)\b/u
  ),
  equipment_map_exercise: bidirectionalActionScope(
    /\b(?:equipment|exercises?|utrustning(?:en)?|övning(?:en|ar|arna)?)\b/u,
    /\b(?:map(?:ped|ping)?|link(?:ed|ing)?|mappa(?:d|de|t)?|koppla(?:d|de|t)?)\b/u
  ),
  routine_save: bidirectionalActionScope(
    /\b(?:routines?|rutin(?:en|er|erna)?)\b/u,
    /\b(?:sav(?:e|ed|ing)|updat(?:e|ed|ing)|spara(?:d|de|t|nde)?|uppdatera(?:d|de|t|nde)?)\b/u
  ),
  workout_start: bidirectionalActionScope(
    /\b(?:workouts?|träningspass(?:et)?)\b/u,
    /\bstart(?:ed|ing|at)?\b/u
  ),
  workout_log_set: bidirectionalActionScope(
    /\b(?:sets?|exercise\s+sets?|setet|övningsset(?:et)?)\b/u,
    /\b(?:log(?:ged|ging)?|record(?:ed|ing)?|logga(?:d|de|t)?|registrera(?:d|de|t)?)\b/u
  ),
  workout_finish: bidirectionalActionScope(
    /\b(?:workouts?|träningspass(?:et)?)\b/u,
    /\b(?:finish(?:ed|ing)?|complet(?:e|ed|ion)|avsluta(?:d|de|t)?|slutför(?:d|de|t)?)\b/u
  ),
  settings_update: bidirectionalActionScope(
    /\b(?:settings?|time\s+zone|locale|time\s+format|inställning(?:en|ar|arna)?|tidszon(?:en)?|språk(?:et)?|tidsformat(?:et)?)\b/u,
    /\b(?:updat(?:e|ed|ing)|sav(?:e|ed|ing)|chang(?:e|ed|ing)|uppdatera(?:d|de|t|nde)?|spara(?:d|de|t|nde)?|ändra(?:d|de|t|nde)?)\b/u
  ),
  connection_link_create: bidirectionalActionScope(
    /\b(?:(?:calendar|account|connection)\s+links?|(?:kalender|konto|anslutnings)länk(?:en)?)\b/u,
    /\b(?:creat(?:e|ed|ion)|made|skapa(?:d|de|t|nde)?)\b/u
  )
}

const uncertainOutcomePattern =
  /\b(?:cannot|can't|could not|couldn't)\s+(?:confirm|determine|tell|verify|know)\b[^.]{0,120}\b(?:whether|if)\b|\bkan\s+inte\s+(?:bekräfta|avgöra|säga|verifiera|veta)\b[^.]{0,120}\b(?:om|huruvida)\b/iu

const categoricalFailurePattern =
  /\b(?:failed|failure|unsuccessful|did not (?:finish|complete|work|apply|save|update|create|start)|was not (?:finished|completed|applied|saved|updated|created|started)|could not (?:finish|complete|apply|save|update|create|start)|misslyckades|misslyckad|fungerade inte|kunde inte (?:slutföra|spara|uppdatera|skapa|starta)|blev inte (?:slutförd|sparad|uppdaterad|skapad|startad))\b/iu

const categoricalSuccessPattern =
  /\b(?:succeeded|successful|worked|finished|completed|applied|saved|updated|created|started|cancelled|canceled|snoozed|confirmed|corrected|acknowledged|logged|removed|deleted|set|lyckades|fungerade|slutförd|klar|sparad|uppdaterad|skapad|startad|avbruten|uppskjuten|bekräftad|rättad|loggad|borttagen|inställd)\b/iu

function responseClauses(text: string): readonly string[] {
  return text
    .split(
      /(?:[.!?;\n]+|\s+—\s+|,\s*(?:and|but|however|yet|och|men|däremot)\s+|\s+(?:but|however|yet|men|däremot)\s+|\s+(?:and|och)\s+(?=(?:I|we|the|a|an|it|they|jag|vi|den|det|de)\b))/iu
    )
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0)
}

function uncertainOutcomeScope(clause: string): string | undefined {
  const match = uncertainOutcomePattern.exec(clause)
  return match?.index === undefined ? undefined : clause.slice(match.index)
}

function toolScopeMatches(toolName: typeof ToolName.Type, text: string): boolean {
  return (
    actionScopeByTool[toolName]?.test(text) === true ||
    actionClaims.some((claim) => claim.requiredTools.includes(toolName) && claim.pattern.test(text))
  )
}

function toolOutcomeIsUncertain(clause: string, toolName: typeof ToolName.Type): boolean {
  const scope = uncertainOutcomeScope(clause)
  return scope !== undefined && toolScopeMatches(toolName, scope)
}

const genericActionClaimPattern =
  /\bI\s+(?:created|saved|updated|changed|started|finished|logged|cancelled|canceled|snoozed|completed|marked|added|deleted|removed|set|proposed|confirmed|corrected|acknowledged)\b|\bjag\s+(?:har\s+)?(?:skapade|skapat|ställde\s+in|ställt\s+in|lade\s+till|lagt\s+till|sparade|sparat|uppdaterade|uppdaterat|ändrade|ändrat|startade|startat|avslutade|avslutat|slutförde|slutfört|loggade|loggat|registrerade|registrerat|avbröt|avbrutit|tog\s+bort|tagit\s+bort|raderade|raderat|sköt\s+upp|skjutit\s+upp|senarelade|senarelagt|flyttade|flyttat|markerade|markerat|föreslog|föreslagit|bekräftade|bekräftat|rättade|rättat|korrigerade|korrigerat)\b/iu

export function validateAssistantResponse(
  raw: string,
  policy: AssistantResponsePolicy
): AssistantResponseValidation {
  try {
    if (raw.length > 16_000) return { ok: false, code: "response_envelope_too_long" }
    const decoded = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(
      JSON.parse(raw)
    )
    if (Array.isArray(decoded)) {
      return { ok: false, code: "malformed_response" }
    }
    const keys = Object.keys(decoded).toSorted()
    const expectedKeys = ["conflict", "protocolVersion", "responseText", "sourceIds", "toolNames"]
    const expectedKeysWithArtifact = [...expectedKeys, "artifact"].toSorted()
    if (
      !(
        (keys.length === expectedKeys.length &&
          keys.every((key, index) => key === expectedKeys[index])) ||
        (keys.length === expectedKeysWithArtifact.length &&
          keys.every((key, index) => key === expectedKeysWithArtifact[index]))
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
      if (internalToolReferences(artifactText).length > 0) {
        return { ok: false, code: "invalid_tool_reference" }
      }
    }
    if (policy.requiresSource === true && value.sourceIds.length === 0) {
      return { ok: false, code: "source_required" }
    }
    if (value.sourceIds.some((sourceId) => !policy.approvedSourceIds.has(sourceId))) {
      return { ok: false, code: "invalid_source_reference" }
    }
    const responseToolNames = new Set<string>(value.toolNames)
    if (
      responseToolNames.size !== value.toolNames.length ||
      responseToolNames.size !== policy.executedToolNames.size ||
      value.toolNames.some((toolName) => !policy.executedToolNames.has(toolName))
    ) {
      return { ok: false, code: "invalid_tool_reference" }
    }
    const textToolReferences = internalToolReferences(value.responseText)
    if (textToolReferences.some((toolName) => !policy.executedToolNames.has(toolName))) {
      return { ok: false, code: "invalid_tool_reference" }
    }
    const clauses = responseClauses(value.responseText)
    const matchedActionClaims = clauses.flatMap((clause) =>
      actionClaims.filter((claim) => claim.pattern.test(clause)).map((claim) => ({ claim, clause }))
    )
    const hasCategoricalUnknownActionClaim = clauses.some((clause) =>
      [...policy.unknownActionToolNames].some((toolName) => {
        if (!toolScopeMatches(toolName, clause)) return false
        if (toolOutcomeIsUncertain(clause, toolName)) return false
        const hasKnownSuccessClaim = matchedActionClaims.some(
          (match) => match.clause === clause && match.claim.requiredTools.includes(toolName)
        )
        return (
          hasKnownSuccessClaim ||
          categoricalFailurePattern.test(clause) ||
          categoricalSuccessPattern.test(clause)
        )
      })
    )
    if (hasCategoricalUnknownActionClaim) {
      return { ok: false, code: "unknown_action_claim" }
    }
    if (
      matchedActionClaims.some(
        ({ claim, clause }) =>
          !claim.requiredTools.some((toolName) => toolOutcomeIsUncertain(clause, toolName)) &&
          claim.requiredTools.every((toolName) => !policy.confirmedActionToolNames.has(toolName))
      )
    ) {
      return { ok: false, code: "unverified_action_claim" }
    }
    const hasUnmatchedGenericActionClaim = clauses.some(
      (clause) =>
        uncertainOutcomeScope(clause) === undefined &&
        genericActionClaimPattern.test(clause) &&
        !matchedActionClaims.some((match) => match.clause === clause)
    )
    if (hasUnmatchedGenericActionClaim) {
      return { ok: false, code: "unverified_action_claim" }
    }
    const citesConflict = value.sourceIds.some((sourceId) =>
      policy.conflictingSourceIds.has(sourceId)
    )
    if (value.conflict === "disclosed" && !citesConflict) {
      return { ok: false, code: "unsupported_conflict" }
    }
    const statesConflict =
      /\b(?:conflict|conflicting|inconsistent|disagree|cannot (?:tell|determine) which)\b/iu.test(
        value.responseText
      ) || /(?:konflikt|motstrid|kan inte avgöra)/iu.test(value.responseText)
    if (citesConflict && (value.conflict !== "disclosed" || !statesConflict)) {
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
    return {
      ok: false,
      code: "invalid_output",
      validationCode: first.code,
      repairAttempted: false
    }
  }

  try {
    const repaired = validateAssistantResponse(await repair(first.code), policy)
    if (repaired.ok) return { ...repaired, repairAttempted: true }
    return {
      ok: false,
      code: "invalid_output",
      validationCode: repaired.code,
      repairAttempted: true
    }
  } catch {
    return {
      ok: false,
      code: "invalid_output",
      validationCode: "repair_failed",
      repairAttempted: true
    }
  }
}
