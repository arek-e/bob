import { reminderCapability } from "@bob/contracts/capabilities/reminders"
import {
  ReminderCancelArguments,
  ReminderCreateArguments,
  ReminderOccurrenceArguments,
  ReminderSnoozeArguments,
  type ToolName,
  type ToolResult
} from "@bob/contracts/tools"
import { Schema } from "effect"

import type {
  ToolCommandAdapter,
  ToolCommandAdapterContext
} from "../conversations/tool-adapter.ts"
import type { ReminderStore } from "./store.ts"

import { jsonObject } from "../../json.ts"
import {
  reminderCreateTimeMatchesRequest,
  reminderMutationMatchesRequest,
  resolveLocalDueAt,
  resolveReminderMutationTarget,
  type ReminderMutationIntent
} from "./rules.ts"

interface ReminderCandidate {
  reminderId: string
  displayText: string
  localDisplayTime?: string
}

interface ReminderRequestedTarget {
  reminderId: string
  occurrenceId?: string
}

function reminderIntentForTool(name: ToolName): ReminderMutationIntent | undefined {
  switch (name) {
    case "reminder_create":
      return "create"
    case "reminder_acknowledge":
      return "acknowledge"
    case "reminder_complete":
      return "complete"
    case "reminder_snooze":
      return "snooze"
    case "reminder_cancel":
      return "cancel"
    default:
      return undefined
  }
}

function confirmationRequired(): ToolResult {
  return {
    ok: false,
    code: "confirmation_required",
    message: "Give one direct reminder instruction before Bob changes a reminder."
  }
}

async function validateMutationTarget(
  context: ToolCommandAdapterContext,
  reminders: ReminderStore,
  intent: Exclude<ReminderMutationIntent, "create">
): Promise<ToolResult | undefined> {
  const { command, run } = context
  const summaries = await reminders.list(command.ownerId)
  let requestedReminderId: string | undefined
  let requestedOccurrenceId: string | undefined
  if (command.name === "reminder_cancel") {
    const args = Schema.decodeUnknownSync(ReminderCancelArguments)(command.arguments)
    requestedReminderId = args.reminderId
    requestedOccurrenceId = args.occurrenceId
  } else {
    const args = Schema.decodeUnknownSync(
      command.name === "reminder_snooze" ? ReminderSnoozeArguments : ReminderOccurrenceArguments
    )(command.arguments)
    requestedOccurrenceId = args.occurrenceId
    requestedReminderId = summaries.find((summary) =>
      summary.actionTargets.some((target) => target.occurrenceId === requestedOccurrenceId)
    )?.id
  }
  const candidates =
    command.name === "reminder_cancel" && requestedOccurrenceId === undefined
      ? summaries.map((summary) => {
          const candidate: ReminderCandidate = {
            reminderId: summary.id,
            displayText: summary.displayText
          }
          if (summary.localDisplayTime !== undefined) {
            candidate.localDisplayTime = summary.localDisplayTime
          }
          return candidate
        })
      : summaries.flatMap((summary) =>
          summary.actionTargets
            .filter((target) => {
              if (intent === "acknowledge") return target.state === "awaiting_response"
              if (intent === "complete" || intent === "snooze") {
                return target.state === "awaiting_response" || target.state === "acknowledged"
              }
              return true
            })
            .map((target) => ({
              reminderId: summary.id,
              occurrenceId: target.occurrenceId,
              displayText: summary.displayText,
              localDisplayTime: target.localDisplayTime
            }))
        )

  if (requestedReminderId === undefined) {
    return {
      ok: false,
      code: "choice_required",
      message: "More than one reminder can match. Open Bob and choose the exact reminder."
    }
  }
  const requestedTarget: ReminderRequestedTarget = { reminderId: requestedReminderId }
  if (requestedOccurrenceId !== undefined) requestedTarget.occurrenceId = requestedOccurrenceId
  if (
    resolveReminderMutationTarget(run.request.userText, requestedTarget, candidates) !== "matched"
  ) {
    return {
      ok: false,
      code: "choice_required",
      message: "More than one reminder can match. Open Bob and choose the exact reminder."
    }
  }
  return undefined
}

export function makeReminderToolAdapter(reminders: ReminderStore): ToolCommandAdapter {
  return {
    capabilityId: reminderCapability.id,
    names: reminderCapability.names,
    async execute(context) {
      const { command, run } = context
      const intent = reminderIntentForTool(command.name)
      if (intent !== undefined) {
        if (!reminderMutationMatchesRequest(run.request.userText, intent)) {
          return confirmationRequired()
        }

        if (intent !== "create") {
          const targetResult = await validateMutationTarget(context, reminders, intent)
          if (targetResult !== undefined) return targetResult
        }
      }

      switch (command.name) {
        case "reminder_create": {
          const args = Schema.decodeUnknownSync(ReminderCreateArguments)(command.arguments)
          if (args.sourceMessageId !== run.messageId) {
            return {
              ok: false,
              code: "source_mismatch",
              message: "The reminder source is invalid."
            }
          }
          if (args.timeZone !== run.request.timeZone) {
            return {
              ok: false,
              code: "time_zone_mismatch",
              message: "Use the owner's current time zone for this reminder."
            }
          }
          const resolvedDueAt = resolveLocalDueAt(args.localDate, args.localTime, args.timeZone)
          if (Date.parse(resolvedDueAt) !== Date.parse(args.dueAt)) {
            return {
              ok: false,
              code: "due_time_mismatch",
              message: "The reminder time does not match its local date and time."
            }
          }
          if (Date.parse(resolvedDueAt) <= Date.parse(run.request.localTime)) {
            return {
              ok: false,
              code: "invalid_due_time",
              message: "Choose a reminder time after the current time."
            }
          }
          if (
            !reminderCreateTimeMatchesRequest(run.request.userText, args, run.request.localTime)
          ) {
            return {
              ok: false,
              code: "confirmation_required",
              message: "Confirm the exact local date and time before Bob creates this reminder."
            }
          }
          const result = await reminders.createOneShot(
            command.ownerId,
            run.channelId,
            run.request.userText,
            args,
            command.idempotencyKey
          )
          return {
            ok: true,
            code: result.duplicate ? "reminder_exists" : "reminder_created",
            message: `Reminder set for ${result.localDisplayTime} ${args.timeZone}.`,
            data: jsonObject(result)
          }
        }
        case "reminder_list": {
          const list = await reminders.list(command.ownerId)
          return {
            ok: true,
            code: "reminder_list",
            message: `${list.length} reminders found.`,
            data: jsonObject({ reminders: list })
          }
        }
        case "reminder_acknowledge": {
          const args = Schema.decodeUnknownSync(ReminderOccurrenceArguments)(command.arguments)
          await reminders.acknowledge(command.ownerId, args.occurrenceId, command.idempotencyKey)
          return {
            ok: true,
            code: "reminder_seen",
            message: "The reminder was marked as seen.",
            data: { occurrenceId: args.occurrenceId }
          }
        }
        case "reminder_complete": {
          const args = Schema.decodeUnknownSync(ReminderOccurrenceArguments)(command.arguments)
          await reminders.complete(command.ownerId, args.occurrenceId, command.idempotencyKey)
          return {
            ok: true,
            code: "reminder_done",
            message: "The reminder was marked as done.",
            data: { occurrenceId: args.occurrenceId }
          }
        }
        case "reminder_snooze": {
          const args = Schema.decodeUnknownSync(ReminderSnoozeArguments)(command.arguments)
          if (args.timeZone !== run.request.timeZone) {
            return {
              ok: false,
              code: "time_zone_mismatch",
              message: "Use the owner's current time zone for this reminder."
            }
          }
          const resolvedDueAt = resolveLocalDueAt(args.localDate, args.localTime, args.timeZone)
          if (Date.parse(resolvedDueAt) !== Date.parse(args.dueAt)) {
            return {
              ok: false,
              code: "due_time_mismatch",
              message: "The snooze time does not match its local date and time."
            }
          }
          if (Date.parse(args.dueAt) <= Date.parse(run.request.localTime)) {
            return {
              ok: false,
              code: "invalid_due_time",
              message: "Choose a snooze time after the current time."
            }
          }
          const occurrenceId = await reminders.snooze(
            command.ownerId,
            args.occurrenceId,
            args.dueAt,
            command.idempotencyKey
          )
          return {
            ok: true,
            code: "reminder_snoozed",
            message: `The reminder was snoozed until ${args.localDate} ${args.localTime} ${args.timeZone}.`,
            data: { occurrenceId, dueAt: args.dueAt }
          }
        }
        case "reminder_cancel": {
          const args = Schema.decodeUnknownSync(ReminderCancelArguments)(command.arguments)
          await reminders.cancel(
            command.ownerId,
            args.reminderId,
            args.occurrenceId,
            command.idempotencyKey
          )
          return {
            ok: true,
            code:
              args.occurrenceId === undefined
                ? "reminder_cancelled"
                : "reminder_occurrence_cancelled",
            message:
              args.occurrenceId === undefined
                ? "The reminder was cancelled."
                : "The reminder occurrence was cancelled.",
            data: jsonObject({ reminderId: args.reminderId, occurrenceId: args.occurrenceId })
          }
        }
        default:
          return {
            ok: false,
            code: "domain_error",
            message: "Bob could not complete this action safely."
          }
      }
    }
  }
}
