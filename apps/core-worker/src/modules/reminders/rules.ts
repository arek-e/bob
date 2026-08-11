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
