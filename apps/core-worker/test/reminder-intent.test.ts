import { describe, expect, it } from "vitest"

import {
  reminderMutationMatchesRequest,
  type ReminderMutationIntent
} from "../src/modules/reminders/rules.ts"

describe("reminder mutation intent", () => {
  const affirmative: ReadonlyArray<readonly [ReminderMutationIntent, string, string]> = [
    [
      "create",
      "Remind me to pack my gym bag tomorrow.",
      "Påminn mig att packa gymväskan i morgon."
    ],
    ["acknowledge", "Mark this reminder as seen.", "Markera påminnelsen som sedd."],
    ["complete", "Done.", "Klar."],
    ["snooze", "Snooze this reminder until 14:00.", "Skjut upp påminnelsen till 14:00."],
    ["cancel", "Cancel this reminder.", "Avbryt påminnelsen."]
  ]

  it.each(affirmative)("accepts direct %s commands in English and Swedish", (intent, en, sv) => {
    expect(reminderMutationMatchesRequest(en, intent)).toBe(true)
    expect(reminderMutationMatchesRequest(sv, intent)).toBe(true)
  })

  it("accepts direct polite questions", () => {
    expect(reminderMutationMatchesRequest("Can you please remind me at 13:00?", "create")).toBe(
      true
    )
    expect(reminderMutationMatchesRequest("Kan du avbryta påminnelsen?", "cancel")).toBe(true)
  })

  const unsafe: ReadonlyArray<readonly [ReminderMutationIntent, string]> = [
    ["create", "Do not remind me tomorrow."],
    ["create", "Påminn mig inte i morgon."],
    ["create", "Create no reminder for tomorrow."],
    ["create", "Skapa ingen påminnelse i morgon."],
    ["acknowledge", "Do not mark this reminder as seen."],
    ["acknowledge", "Markera inte påminnelsen som sedd."],
    ["complete", "I am not asking you to mark it done."],
    ["complete", "Markera inte påminnelsen som klar."],
    ["snooze", "Do not snooze this reminder."],
    ["snooze", "Skjut inte upp påminnelsen."],
    ["cancel", "Do not cancel this reminder."],
    ["cancel", "Avbryt inte påminnelsen."],
    ["cancel", "Cancel this reminder maybe."],
    ["cancel", "Should I cancel this reminder?"],
    ["snooze", "Kanske ska jag skjuta upp påminnelsen."],
    ["cancel", "I was talking about cancelling reminders."]
  ]

  it.each(unsafe)("rejects unsafe %s text: %s", (intent, text) => {
    expect(reminderMutationMatchesRequest(text, intent)).toBe(false)
  })

  it("does not treat reminder content as a second mutation", () => {
    expect(reminderMutationMatchesRequest("Remind me to cancel my gym membership.", "create")).toBe(
      true
    )
    expect(reminderMutationMatchesRequest("Remind me not to skip lunch.", "create")).toBe(true)
  })

  it("rejects a command for the wrong mutation", () => {
    expect(reminderMutationMatchesRequest("Cancel this reminder.", "complete")).toBe(false)
    expect(reminderMutationMatchesRequest("Klar.", "acknowledge")).toBe(false)
  })
})
