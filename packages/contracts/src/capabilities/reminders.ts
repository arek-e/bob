import { Schema } from "effect"

import type { CapabilityModule, ToolDefinition, ToolDefinitionName } from "./definitions.ts"

import { IsoDateTime, ShortText, TimeZone, Uuid } from "../shared.ts"
import { emptyInputSchema, occurrenceInputSchema } from "./definitions.ts"

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

export const reminderToolDefinitions = {
  reminder_create: {
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
        sourceMessageId: { type: "string" },
        requiresAcknowledgment: { type: "boolean" }
      },
      required: [
        "displayText",
        "smsSafeText",
        "localDate",
        "localTime",
        "timeZone",
        "dueAt",
        "sourceMessageId",
        "requiresAcknowledgment"
      ],
      additionalProperties: false
    }
  },
  reminder_list: {
    name: "reminder_list",
    description: "List active reminders and their exact action target IDs.",
    inputSchema: emptyInputSchema
  },
  reminder_acknowledge: {
    name: "reminder_acknowledge",
    description: "Mark one listed reminder occurrence as seen.",
    inputSchema: occurrenceInputSchema
  },
  reminder_complete: {
    name: "reminder_complete",
    description: "Mark one listed reminder occurrence as done.",
    inputSchema: occurrenceInputSchema
  },
  reminder_snooze: {
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
    }
  },
  reminder_cancel: {
    name: "reminder_cancel",
    description:
      "Cancel one listed occurrence when occurrenceId is present. Otherwise, cancel the complete reminder series.",
    inputSchema: {
      type: "object",
      properties: { reminderId: { type: "string" }, occurrenceId: { type: "string" } },
      required: ["reminderId"],
      additionalProperties: false
    }
  }
} as const satisfies Readonly<Partial<Record<ToolDefinitionName, ToolDefinition>>>

export const reminderCapability = {
  id: "reminders",
  version: 1,
  feature: "reminders",
  names: [
    "reminder_create",
    "reminder_list",
    "reminder_acknowledge",
    "reminder_complete",
    "reminder_snooze",
    "reminder_cancel"
  ],
  modelTools: [
    "reminder_create",
    "reminder_list",
    "reminder_acknowledge",
    "reminder_complete",
    "reminder_snooze",
    "reminder_cancel"
  ],
  definitions: reminderToolDefinitions,
  readOnly: ["reminder_list"],
  sourceBound: ["reminder_create"],
  externalOutcomeUnknown: [],
  confirmedActionCodes: {
    reminder_create: ["reminder_created", "reminder_exists"],
    reminder_acknowledge: ["reminder_seen"],
    reminder_complete: ["reminder_done"],
    reminder_snooze: ["reminder_snoozed"],
    reminder_cancel: ["reminder_cancelled", "reminder_occurrence_cancelled"]
  },
  mutationArgumentExclusions: { reminder_create: ["sourceMessageId"] },
  sourceMessageArguments: { reminder_create: "sourceMessageId" }
} as const satisfies CapabilityModule
