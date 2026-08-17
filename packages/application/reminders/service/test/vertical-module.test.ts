import type { DeploymentProfileContext } from "@bob/deployment-profile-types/runtime"

import { describe, expect, it, vi } from "vitest"

import { reminderVerticalModule } from "../src/vertical-module.ts"

interface ReminderBindings {
  readonly REMINDER_CLOCK?: { readonly fetch?: ReturnType<typeof vi.fn> }
  readonly REMINDER_QUIET_HOURS_START?: string
  readonly REMINDER_QUIET_HOURS_END?: string
  readonly REMINDER_DAILY_LIMIT?: number
}

function context(bindings: ReminderBindings): DeploymentProfileContext {
  const fixture = {
    bindings,
    database: {},
    protection: {},
    ownerDataKeys: {},
    conversations: {},
    turns: {},
    settings: {},
    ownerId: "018e6f65-4d55-7a1b-8df4-4ee15ea1dba1",
    ownerTimeZone: "Europe/Stockholm"
  }
  // SAFETY: This focused test does not execute the infrastructure Adapters.
  return fixture as DeploymentProfileContext
}

describe("Reminder Vertical Module", () => {
  it("prepares all Reminder runtime contributions", () => {
    const prepared = reminderVerticalModule.prepare(
      context({
        REMINDER_CLOCK: { fetch: vi.fn() },
        REMINDER_QUIET_HOURS_START: "22:00",
        REMINDER_QUIET_HOURS_END: "07:00",
        REMINDER_DAILY_LIMIT: 12
      })
    )

    expect(prepared.id).toBe("reminders")
    expect(prepared.capability).toBe(reminderVerticalModule.capability)
    expect(prepared.evidenceSources.map(({ id }) => id)).toEqual(["reminder_evidence"])
    expect(prepared.legacyArtifactReaders).toEqual([])
    expect(prepared.deliveryTargets.map(({ targetType }) => targetType)).toEqual([
      "reminder_occurrence"
    ])
    expect(prepared.runtimeModules.conversations.map(({ id }) => id)).toEqual(["reminder-replies"])
    expect(prepared.runtimeModules.ownerRoutes.map(({ id }) => id)).toEqual([
      "reminder-owner-routes"
    ])
    expect(prepared.runtimeModules.scheduledTasks.map(({ id }) => id)).toEqual([
      "reminder-scheduler"
    ])
    expect(prepared.toolAdapters).toHaveLength(1)
    expect(prepared.toolAdapters[0]?.capabilityId).toBe("reminders")
  })

  it("rejects invalid Reminder configuration before assembly", () => {
    expect(() =>
      reminderVerticalModule.prepare(
        context({
          REMINDER_CLOCK: {},
          REMINDER_QUIET_HOURS_START: "22:00",
          REMINDER_QUIET_HOURS_END: "07:00",
          REMINDER_DAILY_LIMIT: 12
        })
      )
    ).toThrow("REMINDER_CLOCK.fetch is required")

    expect(() =>
      reminderVerticalModule.prepare(
        context({
          REMINDER_CLOCK: { fetch: vi.fn() },
          REMINDER_QUIET_HOURS_START: "late",
          REMINDER_QUIET_HOURS_END: "07:00",
          REMINDER_DAILY_LIMIT: 0
        })
      )
    ).toThrow()
  })
})
