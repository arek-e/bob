import { Schema } from "effect"

import { IsoDateTime, JsonObject, NonEmptyText, ShortText, TimeZone, Uuid } from "./shared.ts"

export const ToolName = Schema.Literals([
  "reminder_create",
  "reminder_list",
  "reminder_acknowledge",
  "reminder_complete",
  "reminder_snooze",
  "reminder_cancel",
  "memory_search",
  "memory_propose",
  "memory_confirm",
  "memory_correct",
  "journal_link_create",
  "journal_search_metadata",
  "gym_create",
  "exercise_create",
  "gym_add_equipment",
  "equipment_map_exercise",
  "routine_save",
  "routine_get",
  "workout_start",
  "workout_log_set",
  "workout_finish",
  "workout_last",
  "workout_history"
])

export const ReminderCreateArguments = Schema.Struct({
  displayText: ShortText,
  smsSafeText: ShortText,
  localDate: Schema.String,
  localTime: Schema.String,
  timeZone: TimeZone,
  dueAt: IsoDateTime,
  sourceMessageId: Uuid,
  requiresAcknowledgment: Schema.Boolean
})

export const ToolCommand = Schema.Struct({
  runId: Uuid,
  toolCallId: NonEmptyText,
  idempotencyKey: NonEmptyText,
  ownerId: Uuid,
  name: ToolName,
  arguments: JsonObject
})

export const ToolResult = Schema.Struct({
  ok: Schema.Boolean,
  code: NonEmptyText,
  message: ShortText,
  data: Schema.optionalKey(JsonObject)
})

export type ToolName = typeof ToolName.Type
export type ReminderCreateArguments = typeof ReminderCreateArguments.Type
export type ToolCommand = typeof ToolCommand.Type
export type ToolResult = typeof ToolResult.Type
