import { Temporal } from "@js-temporal/polyfill"

export type ReminderLifecycle = "active" | "paused" | "cancelled" | "completed" | "archived"
export type OccurrenceState =
  | "scheduled"
  | "claimed"
  | "awaiting_delivery"
  | "awaiting_response"
  | "acknowledged"
  | "completed"
  | "snoozed"
  | "missed"
  | "cancelled"

export type ReminderMutationIntent = "create" | "acknowledge" | "complete" | "snooze" | "cancel"

export interface ReminderTargetCandidate {
  readonly reminderId: string
  readonly occurrenceId?: string
  readonly displayText: string
  readonly localDisplayTime?: string
}

export type ReminderTargetResolution = "matched" | "choice_required"

const directRequestPrefix =
  /^(?:(?:please|kindly)(?:,)?\s+|(?:can|could|would)\s+you(?:\s+please)?\s+|(?:snälla)(?:,)?\s+|(?:kan|skulle)\s+du(?:\s+snälla)?\s+)/u

const uncertainRequest =
  /^(?:(?:maybe|perhaps|possibly|i\s+(?:may|might))\b|(?:should|shall|can|could)\s+i\b|what\s+if\b|(?:kanske|möjligen|eventuellt)\b|(?:ska|bör|borde|kan)\s+jag\b|vad\s+händer\s+om\b)/u

const negatedMutation =
  /(?:^(?:no|nej)\b|\b(?:do\s+not|don't|dont|not|never)\b.{0,40}\b(?:create|set|add|schedule|remind|mark|acknowledge|complete|finish|snooze|postpone|delay|move|cancel|delete|remove|stop)\b|\b(?:create|set|add|schedule)\b.{0,24}\bno\b|\b(?:inte|aldrig|ej|ingen|inget|inga)\b.{0,40}\b(?:skapa|lägg|schemalägg|sätt|påminn|markera|bekräfta|slutför|snooza|senarelägg|skjut|flytta|avbryt|radera|stoppa)\b|\b(?:skapa|lägg|schemalägg|sätt|markera|bekräfta|slutför|snooza|senarelägg|skjut|flytta|avbryt|radera|stoppa)\b.{0,24}\b(?:inte|aldrig|ej|ingen|inget|inga)\b|\bpåminn\s+mig\s+(?:inte|aldrig|ej)\b)/u

const unsafeMutationQualifier =
  /\b(?:no|not|never|don't|dont|maybe|perhaps|possibly|nej|inte|aldrig|ej|ingen|inget|inga|kanske|möjligen|eventuellt)\b/u

const intentPatterns: Readonly<Record<ReminderMutationIntent, RegExp>> = {
  create:
    /^(?:remind\s+me\b|(?:create|set|add|schedule)\b.{0,32}\breminder\b|påminn(?:a)?\s+mig\b|(?:skapa|schemalägg|sätt)\b.{0,32}\bpåminnelse\b|lägg\s+(?:till|in)\b.{0,32}\bpåminnelse\b)/u,
  acknowledge:
    /^(?:seen|acknowledged|got\s+it|i\s+(?:have\s+)?(?:seen|read)\s+(?:it|this|the\s+reminder)|mark\b.{0,32}\b(?:seen|acknowledged)|sett|uppfattat|jag\s+har\s+sett\s+(?:den|det|påminnelsen)|markera\b.{0,32}\b(?:sedd|sett|bekräftad))\b/u,
  complete:
    /^(?:done|complete|completed|finished|i\s+(?:did|finished|completed)\s+it|mark\b.{0,32}\b(?:done|complete|completed)|klar|klart|färdig|färdigt|jag\s+(?:är\s+klar|gjorde\s+det)|markera\b.{0,32}\b(?:klar|klart|färdig|färdigt)|slutför\b)/u,
  snooze:
    /^(?:(?:snooze|postpone|delay)\b|move\b.{0,32}\breminder\b|(?:snooza|senarelägg)\b|skjut(?:a)?\s+upp\b|flytta\b.{0,32}\bpåminnels(?:e|en)\b)/u,
  cancel:
    /^(?:(?:cancel|delete|remove|stop)\b.{0,32}\b(?:reminder|it|this)\b|(?:avbryt|avbryta|radera|stoppa)\b.{0,32}\b(?:påminnels(?:e|en)|den|det)\b|ta\s+bort\b.{0,32}\b(?:påminnels(?:e|en)|den|det)\b)/u
}

/** Return true only when the owner gives one direct reminder mutation command. */
export function reminderMutationMatchesRequest(
  text: string,
  intent: ReminderMutationIntent
): boolean {
  const normalized = text.normalize("NFKC").trim().toLocaleLowerCase("sv-SE").replace(/\s+/gu, " ")
  if (
    normalized.length === 0 ||
    uncertainRequest.test(normalized) ||
    negatedMutation.test(normalized) ||
    (intent !== "create" && unsafeMutationQualifier.test(normalized))
  ) {
    return false
  }

  const prefix = normalized.match(directRequestPrefix)
  if (normalized.endsWith("?") && prefix === null) return false
  const direct = (prefix === null ? normalized : normalized.slice(prefix[0].length)).replace(
    /[.!?]+$/u,
    ""
  )
  return intentPatterns[intent].test(direct)
}

function normalizedTargetText(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("sv-SE").replace(/\s+/gu, " ")
}

function targetMatchScore(text: string, candidate: ReminderTargetCandidate): number {
  let score = 0
  const displayText = normalizedTargetText(candidate.displayText)
  if (displayText.length >= 2 && text.includes(displayText)) score += 1
  const localDate = candidate.localDisplayTime?.match(/^(\d{4}-\d{2}-\d{2})/u)?.[1]
  if (localDate !== undefined && text.includes(localDate)) score += 2
  const localTime = candidate.localDisplayTime?.match(/T(\d{2}:\d{2})/u)?.[1]
  if (localTime !== undefined && text.includes(localTime)) score += 1
  return score
}

/**
 * Fail closed when the owner can mean more than one reminder target.
 *
 * Internal IDs never select a target by themselves. One current target is safe.
 * Multiple targets require one unique display label or local time in the request.
 */
export function resolveReminderMutationTarget(
  text: string,
  requested: { readonly reminderId: string; readonly occurrenceId?: string },
  candidates: readonly ReminderTargetCandidate[]
): ReminderTargetResolution {
  const requestedCandidate = candidates.find(
    (candidate) =>
      candidate.reminderId === requested.reminderId &&
      candidate.occurrenceId === requested.occurrenceId
  )
  if (requestedCandidate === undefined) return "choice_required"
  if (candidates.length === 1) return "matched"

  const normalized = normalizedTargetText(text)
  const scored = candidates.map((candidate) => ({
    candidate,
    score: targetMatchScore(normalized, candidate)
  }))
  const bestScore = Math.max(...scored.map(({ score }) => score))
  const named = scored
    .filter(({ score }) => score > 0 && score === bestScore)
    .map(({ candidate }) => candidate)
  return named.length === 1 && named[0] === requestedCandidate ? "matched" : "choice_required"
}

const monthNames = [
  ["january", "januari"],
  ["february", "februari"],
  ["march", "mars"],
  ["april", "april"],
  ["may", "maj"],
  ["june", "juni"],
  ["july", "juli"],
  ["august", "augusti"],
  ["september", "september"],
  ["october", "oktober"],
  ["november", "november"],
  ["december", "december"]
] as const

/** Require the model's exact local reminder date and time to occur in the owner request. */
export function reminderCreateTimeMatchesRequest(
  text: string,
  input: { readonly localDate: string; readonly localTime: string; readonly timeZone: string },
  currentInstant: string
): boolean {
  const normalized = normalizedTargetText(text)
  const requestedDate = Temporal.PlainDate.from(input.localDate)
  const requestedTime = Temporal.PlainTime.from(input.localTime)
  const currentDate = Temporal.Instant.from(currentInstant)
    .toZonedDateTimeISO(input.timeZone)
    .toPlainDate()

  const hour = String(requestedTime.hour).padStart(2, "0")
  const minute = String(requestedTime.minute).padStart(2, "0")
  const shortHour = String(requestedTime.hour)
  const meridiem = requestedTime.hour >= 12 ? "pm" : "am"
  const twelveHour = String(requestedTime.hour % 12 || 12)
  const timeMatches =
    normalized.includes(`${hour}:${minute}`) ||
    normalized.includes(`${hour}.${minute}`) ||
    normalized.includes(`${shortHour}:${minute}`) ||
    normalized.includes(`${shortHour}.${minute}`) ||
    normalized.includes(`${twelveHour}:${minute} ${meridiem}`) ||
    normalized.includes(`${twelveHour} ${meridiem}`) ||
    new RegExp(`\\b(?:at|kl(?:ockan)?)\\s+${shortHour}\\b`, "u").test(normalized)
  if (!timeMatches) return false

  const tomorrow = /\b(?:tomorrow|i\s+morgon|imorgon)\b/u.test(normalized)
  if (tomorrow) return Temporal.PlainDate.compare(requestedDate, currentDate.add({ days: 1 })) === 0
  const today = /\b(?:today|idag|i\s+dag)\b/u.test(normalized)
  if (today) return Temporal.PlainDate.compare(requestedDate, currentDate) === 0
  if (normalized.includes(input.localDate)) return true

  const month = monthNames[requestedDate.month - 1]
  const day = String(requestedDate.day)
  const numericDates = [
    `${requestedDate.year}-${String(requestedDate.month).padStart(2, "0")}-${String(requestedDate.day).padStart(2, "0")}`,
    `${requestedDate.day}/${requestedDate.month}`,
    `${requestedDate.day}.${requestedDate.month}`
  ]
  const namedDate = month?.some(
    (name) => normalized.includes(`${name} ${day}`) || normalized.includes(`${day} ${name}`)
  )
  if (numericDates.some((date) => normalized.includes(date)) || namedDate === true) return true

  return Temporal.PlainDate.compare(requestedDate, currentDate) === 0
}

const occurrenceTransitions: Readonly<Record<OccurrenceState, readonly OccurrenceState[]>> = {
  scheduled: ["claimed", "cancelled"],
  claimed: ["scheduled", "awaiting_delivery", "cancelled"],
  awaiting_delivery: ["awaiting_response", "missed", "cancelled"],
  awaiting_response: ["acknowledged", "completed", "snoozed", "missed", "cancelled"],
  acknowledged: ["completed", "snoozed", "cancelled"],
  completed: [],
  snoozed: [],
  missed: [],
  cancelled: []
}

export function transitionOccurrence(from: OccurrenceState, to: OccurrenceState): OccurrenceState {
  if (!occurrenceTransitions[from].includes(to)) {
    throw new Error(`Invalid reminder occurrence transition: ${from} -> ${to}`)
  }
  return to
}

export function resolveLocalDueAt(localDate: string, localTime: string, timeZone: string): string {
  const date = Temporal.PlainDate.from(localDate)
  const time = Temporal.PlainTime.from(localTime)
  return Temporal.ZonedDateTime.from(
    {
      timeZone,
      year: date.year,
      month: date.month,
      day: date.day,
      hour: time.hour,
      minute: time.minute,
      second: time.second
    },
    { disambiguation: "compatible" }
  )
    .toInstant()
    .toString()
}

export function localDisplay(dueAt: string, timeZone: string): string {
  return Temporal.Instant.from(dueAt).toZonedDateTimeISO(timeZone).toString({
    smallestUnit: "minute",
    timeZoneName: "never"
  })
}

export function occurrenceIdempotencyKey(
  reminderId: string,
  intendedDueAt: string,
  sequence: number
): string {
  return `${reminderId}:${intendedDueAt}:${sequence}`
}

export interface QuietHours {
  readonly start: string
  readonly end: string
  readonly timeZone: string
}

export function deferForQuietHours(dueAt: string, quiet: QuietHours): string {
  const current = Temporal.Instant.from(dueAt).toZonedDateTimeISO(quiet.timeZone)
  const start = Temporal.PlainTime.from(quiet.start)
  const end = Temporal.PlainTime.from(quiet.end)
  const time = current.toPlainTime()
  const crossesMidnight = Temporal.PlainTime.compare(start, end) >= 0
  const isQuiet = crossesMidnight
    ? Temporal.PlainTime.compare(time, start) >= 0 || Temporal.PlainTime.compare(time, end) < 0
    : Temporal.PlainTime.compare(time, start) >= 0 && Temporal.PlainTime.compare(time, end) < 0
  if (!isQuiet) return dueAt
  const endDate =
    crossesMidnight && Temporal.PlainTime.compare(time, start) >= 0
      ? current.toPlainDate().add({ days: 1 })
      : current.toPlainDate()
  return Temporal.ZonedDateTime.from(
    {
      timeZone: quiet.timeZone,
      year: endDate.year,
      month: endDate.month,
      day: endDate.day,
      hour: end.hour,
      minute: end.minute
    },
    { disambiguation: "compatible" }
  )
    .toInstant()
    .toString()
}

export function localDayBounds(
  at: string,
  timeZone: string
): {
  readonly start: string
  readonly end: string
} {
  const local = Temporal.Instant.from(at).toZonedDateTimeISO(timeZone)
  const date = local.toPlainDate()
  const start = Temporal.ZonedDateTime.from({
    timeZone,
    year: date.year,
    month: date.month,
    day: date.day
  })
  return { start: start.toInstant().toString(), end: start.add({ days: 1 }).toInstant().toString() }
}

export function nextDailyWindow(at: string, quiet: QuietHours): string {
  const local = Temporal.Instant.from(at).toZonedDateTimeISO(quiet.timeZone)
  const nextDate = local.toPlainDate().add({ days: 1 })
  const end = Temporal.PlainTime.from(quiet.end)
  return Temporal.ZonedDateTime.from(
    {
      timeZone: quiet.timeZone,
      year: nextDate.year,
      month: nextDate.month,
      day: nextDate.day,
      hour: end.hour,
      minute: end.minute
    },
    { disambiguation: "compatible" }
  )
    .toInstant()
    .toString()
}

export function nextRecurringDueAt(currentDueAt: string, rule: string, timeZone: string): string {
  const fields = new Map(
    rule
      .replace(/^RRULE:/, "")
      .split(";")
      .map((part) => part.split("=", 2) as [string, string])
  )
  const interval = Number(fields.get("INTERVAL") ?? "1")
  if (!Number.isInteger(interval) || interval < 1) throw new Error("Invalid recurrence interval")
  const current = Temporal.Instant.from(currentDueAt).toZonedDateTimeISO(timeZone)
  switch (fields.get("FREQ")) {
    case "DAILY":
      return current.add({ days: interval }).toInstant().toString()
    case "WEEKLY":
      return current.add({ weeks: interval }).toInstant().toString()
    case "MONTHLY":
      return current.add({ months: interval }).toInstant().toString()
    default:
      throw new Error("Unsupported recurrence frequency")
  }
}
