import { IsoDateTime, NonEmptyText, TimeZone, Uuid } from "@bob/core-capabilities-types/shared"
import { Schema } from "effect"

export const ReminderSummary = Schema.Struct({
  id: Uuid,
  displayText: NonEmptyText,
  nextDueAt: Schema.optionalKey(IsoDateTime),
  localDisplayTime: Schema.optionalKey(Schema.String),
  timeZone: TimeZone,
  state: Schema.Literals(["active", "paused"]),
  actionTargets: Schema.Array(
    Schema.Struct({
      occurrenceId: Uuid,
      dueAt: IsoDateTime,
      localDisplayTime: Schema.String,
      state: Schema.Literals([
        "scheduled",
        "claimed",
        "awaiting_delivery",
        "awaiting_response",
        "acknowledged"
      ])
    })
  )
})

export const ReminderList = Schema.Struct({ reminders: Schema.Array(ReminderSummary) })
export const ReminderSnoozeRequest = Schema.Struct({ dueAt: IsoDateTime })

export type ReminderSummary = typeof ReminderSummary.Type
export type ReminderList = typeof ReminderList.Type
export type ReminderSnoozeRequest = typeof ReminderSnoozeRequest.Type
