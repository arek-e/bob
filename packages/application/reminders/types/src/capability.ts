import type { CapabilityModule } from "@bob/tools-types/definitions"

import { IsoDateTime, ShortText, TimeZone, Uuid } from "@bob/shared-types/shared"
import { emptyInputSchema, occurrenceInputSchema } from "@bob/tools-types/definitions"
import { Schema } from "effect"

export const ReminderCreateArguments = Schema.Struct({
  displayText: ShortText,
  smsSafeText: ShortText,
  localDate: Schema.String,
  localTime: Schema.String,
  timeZone: TimeZone,
  dueAt: IsoDateTime,
  sourceMessageId: Uuid
})
export const ReminderOccurrenceArguments = Schema.Struct({ occurrenceId: Uuid })
export const ReminderSnoozeArguments = Schema.Struct({
  occurrenceId: Uuid,
  localDate: Schema.String,
  localTime: Schema.String,
  timeZone: TimeZone,
  dueAt: IsoDateTime
})
export const ReminderCancelArguments = Schema.Struct({
  reminderId: Uuid,
  occurrenceId: Schema.optionalKey(Uuid)
})
export type ReminderCreateArguments = typeof ReminderCreateArguments.Type
export type ReminderOccurrenceArguments = typeof ReminderOccurrenceArguments.Type
export type ReminderSnoozeArguments = typeof ReminderSnoozeArguments.Type
export type ReminderCancelArguments = typeof ReminderCancelArguments.Type

export const reminderCapability = {
  id: "reminders",
  version: 1,
  feature: "reminders",
  tools: [
    {
      kind: "model",
      name: "reminder_create",
      description: "Create one confirmed reminder with an absolute local date and time.",
      inputSchema: {
        type: "object",
        properties: {
          displayText: { type: "string", minLength: 1, maxLength: 1_200 },
          smsSafeText: { type: "string", minLength: 1, maxLength: 1_200 },
          localDate: { type: "string" },
          localTime: { type: "string" },
          timeZone: { type: "string" },
          dueAt: { type: "string" },
          sourceMessageId: { type: "string" }
        },
        required: [
          "displayText",
          "smsSafeText",
          "localDate",
          "localTime",
          "timeZone",
          "dueAt",
          "sourceMessageId"
        ],
        additionalProperties: false
      },
      sourceBound: true,
      confirmedActionCodes: ["reminder_created", "reminder_exists"],
      mutationArgumentExclusions: ["sourceMessageId"],
      sourceMessageArgument: "sourceMessageId"
    },
    {
      kind: "model",
      name: "reminder_list",
      description: "List active reminders and their exact action target IDs.",
      inputSchema: emptyInputSchema,
      readOnly: true
    },
    {
      kind: "model",
      name: "reminder_acknowledge",
      description: "Mark one listed reminder occurrence as seen.",
      inputSchema: occurrenceInputSchema,
      confirmedActionCodes: ["reminder_seen"]
    },
    {
      kind: "model",
      name: "reminder_complete",
      description: "Mark one listed reminder occurrence as done.",
      inputSchema: occurrenceInputSchema,
      confirmedActionCodes: ["reminder_done"]
    },
    {
      kind: "model",
      name: "reminder_snooze",
      description:
        "Snooze one listed occurrence to an absolute local date and time in the owner's current time zone.",
      inputSchema: {
        type: "object",
        properties: {
          occurrenceId: { type: "string" },
          localDate: { type: "string" },
          localTime: { type: "string" },
          timeZone: { type: "string" },
          dueAt: { type: "string" }
        },
        required: ["occurrenceId", "localDate", "localTime", "timeZone", "dueAt"],
        additionalProperties: false
      },
      confirmedActionCodes: ["reminder_snoozed"]
    },
    {
      kind: "model",
      name: "reminder_cancel",
      description:
        "Cancel one listed occurrence when occurrenceId is present. Otherwise, cancel the complete reminder series.",
      inputSchema: {
        type: "object",
        properties: { reminderId: { type: "string" }, occurrenceId: { type: "string" } },
        required: ["reminderId"],
        additionalProperties: false
      },
      confirmedActionCodes: ["reminder_cancelled", "reminder_occurrence_cancelled"]
    }
  ]
} as const satisfies CapabilityModule
