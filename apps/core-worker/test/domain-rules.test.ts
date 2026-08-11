import { describe, expect, it } from "vitest"

import { boundContextItems } from "../src/modules/context/store.ts"
import { journalModelContext } from "../src/modules/journal/rules.ts"
import { decideCandidate, deriveMemoryPolicy } from "../src/modules/memory/rules.ts"
import { resolveShortReply } from "../src/modules/policy/rules.ts"
import {
  nextRecurringDueAt,
  resolveLocalDueAt,
  transitionOccurrence
} from "../src/modules/reminders/rules.ts"
import {
  hasExplicitRoutineApproval,
  isTrainingMutationRequest,
  trainingSafetySignal,
  trainingSafetyDecision
} from "../src/modules/training/rules.ts"

describe("deterministic domain rules", () => {
  it("uses the earlier offset when Stockholm local time repeats", () => {
    expect(resolveLocalDueAt("2026-10-25", "02:30", "Europe/Stockholm")).toBe(
      "2026-10-25T00:30:00Z"
    )
  })

  it("shifts forward when a local time does not exist", () => {
    expect(resolveLocalDueAt("2026-03-29", "02:30", "Europe/Stockholm")).toBe(
      "2026-03-29T01:30:00Z"
    )
  })

  it("keeps recurring wall time over daylight-saving changes", () => {
    expect(
      nextRecurringDueAt("2026-03-28T08:00:00Z", "FREQ=DAILY;INTERVAL=1", "Europe/Stockholm")
    ).toBe("2026-03-29T07:00:00Z")
  })

  it("rejects delivery as task acknowledgment", () => {
    expect(() => transitionOccurrence("awaiting_delivery", "acknowledged")).toThrow()
  })

  it("does not bind an ambiguous done reply", () => {
    const expiresAt = "2026-08-12T00:00:00.000Z"
    expect(
      resolveShortReply(
        "done",
        [
          { id: "1", command: "done", targetType: "reminder", targetId: "1", expiresAt },
          { id: "2", command: "done", targetType: "workout", targetId: "2", expiresAt }
        ],
        new Date("2026-08-11T00:00:00.000Z")
      ).kind
    ).toBe("ambiguous")
  })

  it("never promotes background model output", () => {
    expect(
      decideCandidate({
        assertionKind: "user_stated",
        originClass: "background_model",
        sensitive: false,
        highImpact: false,
        explicitRemember: true,
        conflictsWithConfirmed: false
      })
    ).toBe("proposed")
  })

  it("makes every agent memory proposal private and model-ineligible", () => {
    expect(
      deriveMemoryPolicy({
        authority: "agent",
        scope: "preferences",
        originClass: "owner_input"
      })
    ).toEqual({ sensitivity: "private", modelEligible: false, channelEligible: false })
  })

  it("does not return raw journal text to the model", () => {
    expect(
      journalModelContext({
        id: "entry",
        createdAt: "2026-08-11T00:00:00.000Z",
        tags: ["private"],
        rawText: "secret"
      })
    ).toBeUndefined()
  })

  it("stops training guidance after machine confusion", () => {
    expect(
      trainingSafetyDecision({ painReported: false, injuryReported: false, machineConfusion: true })
    ).toMatchObject({ stop: true, code: "machine_confusion" })
  })

  it("requires owner words for routine approval", () => {
    expect(hasExplicitRoutineApproval("Save this routine for me.")).toBe(true)
    expect(hasExplicitRoutineApproval("What routine do you suggest?")).toBe(false)
    expect(hasExplicitRoutineApproval("Do not save this routine.")).toBe(false)
    expect(hasExplicitRoutineApproval("I do not approve this workout plan.")).toBe(false)
  })

  it("creates training proposals only from affirmative owner commands", () => {
    expect(isTrainingMutationRequest("Add this gym to my profile.")).toBe(true)
    expect(isTrainingMutationRequest("Can you add this gym?")).toBe(false)
    expect(isTrainingMutationRequest("Do not add this machine.")).toBe(false)
    expect(isTrainingMutationRequest("I don't want to start the workout.")).toBe(false)
  })

  it("detects training safety signals from trusted owner text", () => {
    expect(trainingSafetySignal("My knee hurts after that set")).toBe("pain_or_injury")
    expect(trainingSafetySignal("I do not understand this machine")).toBe("machine_confusion")
    expect(trainingSafetySignal("Log ten reps")).toBeUndefined()
  })

  it("bounds each context item and the complete pack", () => {
    const items = Array.from({ length: 5 }, (_, index) => ({
      kind: "profile" as const,
      text: String(index).repeat(100),
      instruction: false as const,
      conflict: false,
      sources: []
    }))
    const bounded = boundContextItems(items, 180, 64)
    expect(bounded.every((item) => item.text.length <= 64)).toBe(true)
    expect(bounded.reduce((sum, item) => sum + item.text.length, 0)).toBeLessThanOrEqual(180)
  })
})
