import { describe, expect, it } from "vitest"

import { boundContextItems } from "../src/modules/context/store.ts"
import {
  selectTools,
  selectToolsWithPriorCapabilities
} from "../src/modules/context/tool-selection.ts"
import { journalAgentMetadata, journalModelContext } from "../src/modules/journal/rules.ts"
import { decideCandidate, deriveMemoryPolicy } from "../src/modules/memory/rules.ts"
import {
  classifyDeterministicCommand,
  isArtifactResendRequest,
  resolveShortReply,
  urgentSafetyResponse
} from "../src/modules/policy/rules.ts"
import {
  nextRecurringDueAt,
  resolveLocalDueAt,
  transitionOccurrence
} from "../src/modules/reminders/rules.ts"
import {
  isSettingsMutationRequest,
  settingsUpdateMatchesRequest
} from "../src/modules/settings/rules.ts"
import {
  hasExplicitRoutineApproval,
  isTrainingMutationRequest,
  trainingSafetyResponse,
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

  it.each([
    ["HJÄLP", "help"],
    ["KLART", "done"],
    ["SETT", "seen"],
    ["DAGBOK", "journal"],
    ["UPPREPA", "repeat"],
    ["VARFÖR", "why"],
    ["PAUSA", "pause"],
    ["ÅNGRA", "undo"]
  ] as const)("maps the Swedish command %s to %s", (text, command) => {
    expect(classifyDeterministicCommand(text)).toBe(command)
  })

  it("keeps Swedish command aliases exact", () => {
    expect(classifyDeterministicCommand("upprepa meddelandet")).toBeUndefined()
    expect(classifyDeterministicCommand("igen")).toBeUndefined()
  })

  it.each([
    "Send the plan again",
    "Please show me that workout again.",
    "Skicka träningsplanen igen",
    "Visa den igen"
  ])("recognizes an artifact resend request: %s", (text) => {
    expect(isArtifactResendRequest(text)).toBe(true)
  })

  it("does not capture a normal request as an artifact resend", () => {
    expect(isArtifactResendRequest("Make me another workout plan")).toBe(false)
  })

  it.each([
    "Jag tänker ta livet av mig.",
    "Jag har självmordstankar.",
    "Jag är i omedelbar fara.",
    "Jag kan inte andas.",
    "Jag har ont i bröstet."
  ])("returns the fixed urgent response for Swedish danger text", (text) => {
    expect(urgentSafetyResponse(text)).toContain("ring 112 nu")
  })

  it("does not classify ordinary Swedish text as urgent", () => {
    expect(urgentSafetyResponse("Jag vill planera morgondagens träning.")).toBeUndefined()
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

  it("keeps journal summaries and entry IDs out of agent metadata", () => {
    expect(
      journalAgentMetadata({
        id: "private-entry-id",
        createdAt: "2026-08-11T00:00:00.000Z",
        tags: ["training"],
        approvedSummary: "Private approved summary",
        rawText: "Private journal text"
      })
    ).toEqual({
      createdAt: "2026-08-11T00:00:00.000Z",
      tags: ["training"]
    })
  })

  it("stops training guidance after machine confusion", () => {
    expect(
      trainingSafetyDecision({ painReported: false, injuryReported: false, machineConfusion: true })
    ).toMatchObject({ stop: true, code: "machine_confusion" })
  })

  it("uses a fixed Swedish training safety response for Swedish owner text", () => {
    expect(trainingSafetyResponse("Mitt knä gör ont efter setet.")).toBe(
      "Avsluta övningen nu. Öka inte vikten. Be en kvalificerad tränare eller vårdpersonal om hjälp."
    )
    expect(trainingSafetyResponse("Jag förstår inte den här maskinen.")).toBe(
      "Avsluta övningen nu. Öka inte vikten. Be en kvalificerad tränare eller vårdpersonal om hjälp."
    )
    expect(trainingSafetyResponse("My knee hurts after that set.")).toBe(
      "Stop this exercise now. Do not increase the weight. Ask a qualified trainer or health professional for help."
    )
  })

  it("requires owner words for routine approval", () => {
    expect(hasExplicitRoutineApproval("Save this routine for me.")).toBe(true)
    expect(hasExplicitRoutineApproval("What routine do you suggest?")).toBe(false)
    expect(hasExplicitRoutineApproval("Do not save this routine.")).toBe(false)
    expect(hasExplicitRoutineApproval("I do not approve this workout plan.")).toBe(false)
    expect(hasExplicitRoutineApproval("Spara den här rutinen åt mig.")).toBe(true)
    expect(hasExplicitRoutineApproval("Jag godkänner träningsplanen.")).toBe(true)
    expect(hasExplicitRoutineApproval("Rutinen ser bra ut.")).toBe(true)
    expect(hasExplicitRoutineApproval("Spara inte den här rutinen.")).toBe(false)
    expect(hasExplicitRoutineApproval("Jag godkänner inte träningsplanen.")).toBe(false)
    expect(hasExplicitRoutineApproval("Är rutinen godkänd?")).toBe(false)
    expect(hasExplicitRoutineApproval("Vill du spara rutinen")).toBe(false)
  })

  it("creates training proposals only from affirmative owner commands", () => {
    expect(isTrainingMutationRequest("Add this gym to my profile.")).toBe(true)
    expect(isTrainingMutationRequest("Can you add this gym?")).toBe(false)
    expect(isTrainingMutationRequest("Do not add this machine.")).toBe(false)
    expect(isTrainingMutationRequest("I don't want to start the workout.")).toBe(false)
    expect(isTrainingMutationRequest("Lägg till det här gymmet.")).toBe(true)
    expect(isTrainingMutationRequest("Starta träningspasset.")).toBe(true)
    expect(isTrainingMutationRequest("Kan du lägga till det här gymmet")).toBe(false)
    expect(isTrainingMutationRequest("Vill du starta träningspasset")).toBe(false)
    expect(isTrainingMutationRequest("Vilken maskin ska jag lägga till?")).toBe(false)
    expect(isTrainingMutationRequest("Lägg inte till den här maskinen.")).toBe(false)
    expect(isTrainingMutationRequest("Jag vill inte starta träningspasset.")).toBe(false)
  })

  it("detects training safety signals from trusted owner text", () => {
    expect(trainingSafetySignal("My knee hurts after that set")).toBe("pain_or_injury")
    expect(trainingSafetySignal("I do not understand this machine")).toBe("machine_confusion")
    expect(trainingSafetySignal("Log ten reps")).toBeUndefined()
    expect(trainingSafetySignal("Mitt knä gör ont efter setet.")).toBe("pain_or_injury")
    expect(trainingSafetySignal("Jag skadade axeln under övningen.")).toBe("pain_or_injury")
    expect(trainingSafetySignal("Jag är osäker på hur jag använder maskinen.")).toBe(
      "machine_confusion"
    )
    expect(trainingSafetySignal("Jag förstår inte den här maskinen.")).toBe("machine_confusion")
    expect(trainingSafetySignal("Mitt knä gör inte ont.")).toBeUndefined()
    expect(trainingSafetySignal("Jag har ingen smärta.")).toBeUndefined()
    expect(trainingSafetySignal("Jag är inte skadad.")).toBeUndefined()
    expect(trainingSafetySignal("Jag skadade inte axeln.")).toBeUndefined()
    expect(trainingSafetySignal("Jag är inte osäker på maskinen.")).toBeUndefined()
    expect(trainingSafetySignal("I am not injured.")).toBeUndefined()
    expect(trainingSafetySignal("I am not confused by this machine.")).toBeUndefined()
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

  it("selects only owner settings tools for locality requests", () => {
    expect(selectTools("What time zone are you using?")).toEqual([
      "settings_get",
      "settings_update"
    ])
    expect(selectTools("Use 24-hour time.")).toEqual(["settings_get", "settings_update"])
    expect(selectTools("Vilken tidszon använder du?")).toEqual(["settings_get", "settings_update"])
    expect(selectTools("Ändra mitt tidsformat till 24-timmarsformat.")).toEqual([
      "settings_get",
      "settings_update"
    ])
  })

  it("requires a direct owner instruction before a settings change", () => {
    expect(isSettingsMutationRequest("Set my time zone to America/New_York.")).toBe(true)
    expect(isSettingsMutationRequest("What time zone are you using?")).toBe(false)
    expect(isSettingsMutationRequest("Do not change my time zone.")).toBe(false)
    expect(isSettingsMutationRequest("Ändra min tidszon till Europe/Stockholm.")).toBe(true)
    expect(isSettingsMutationRequest("Använd 24-timmarsformat.")).toBe(true)
    expect(isSettingsMutationRequest("Vilken tidszon använder du?")).toBe(false)
    expect(isSettingsMutationRequest("Kan du ändra min tidszon")).toBe(false)
    expect(isSettingsMutationRequest("Vill du ändra min tidszon")).toBe(false)
    expect(isSettingsMutationRequest("Ändra inte min tidszon.")).toBe(false)
    expect(
      settingsUpdateMatchesRequest("Set my time zone to America/New_York.", {
        timeZone: "America/New_York"
      })
    ).toBe(true)
    expect(
      settingsUpdateMatchesRequest("Set my time zone to America/New_York.", {
        timeZone: "America/New_York",
        locale: "en-US"
      })
    ).toBe(false)
    expect(
      settingsUpdateMatchesRequest("Ändra min tidszon till Europe/Stockholm.", {
        timeZone: "Europe/Stockholm"
      })
    ).toBe(true)
    expect(
      settingsUpdateMatchesRequest("Använd svenska och 24-timmarsformat.", {
        locale: "sv-SE",
        hourCycle: "h23"
      })
    ).toBe(true)
    expect(
      settingsUpdateMatchesRequest("Ändra min tidszon till Europe/Stockholm.", {
        timeZone: "Europe/Stockholm",
        locale: "sv-SE"
      })
    ).toBe(false)
    expect(
      settingsUpdateMatchesRequest("Set my time zone to America/New_York.", {
        timeZone: "Europe/Stockholm"
      })
    ).toBe(false)
    expect(
      settingsUpdateMatchesRequest("Använd svenska och 24-timmarsformat.", {
        locale: "en-US",
        hourCycle: "h23"
      })
    ).toBe(false)
    expect(
      settingsUpdateMatchesRequest("Use 24-hour time format.", {
        hourCycle: "h12"
      })
    ).toBe(false)
  })

  it("gives reminder requests the complete bounded tool surface", () => {
    expect(selectTools("Snooze my reminder until 14:00.")).toEqual([
      "reminder_create",
      "reminder_list",
      "reminder_acknowledge",
      "reminder_complete",
      "reminder_snooze",
      "reminder_cancel"
    ])
    expect(selectTools("Påminn mig att ta nycklarna")).toEqual([
      "reminder_create",
      "reminder_list",
      "reminder_acknowledge",
      "reminder_complete",
      "reminder_snooze",
      "reminder_cancel"
    ])
  })

  it("uses a safe prior capability only for an explicit short follow-up", () => {
    expect(selectToolsWithPriorCapabilities("List", ["reminder_list", "reminder_create"])).toEqual(
      expect.arrayContaining(["memory_search", "memory_correct", "reminder_list"])
    )
    expect(selectToolsWithPriorCapabilities("List", ["reminder_create"])).not.toContain(
      "reminder_create"
    )
    expect(selectToolsWithPriorCapabilities("Do not list them", ["reminder_list"])).not.toContain(
      "reminder_list"
    )
    expect(selectToolsWithPriorCapabilities("List workouts", ["reminder_list"])).not.toContain(
      "reminder_list"
    )
  })

  it("routes Swedish journal and training requests to their bounded tools", () => {
    expect(selectTools("Sök i min dagbok.")).toEqual([
      "journal_link_create",
      "journal_search_metadata"
    ])
    expect(selectTools("Visa min träningsrutin.")).toContain("routine_get")
    expect(selectTools("Lägg till den här övningen.")).toContain("exercise_create")
    expect(selectTools("Vilka maskiner och övningar finns på mitt gym?")).toEqual(
      expect.arrayContaining(["gym_list", "equipment_list", "exercise_list"])
    )
    expect(selectTools("Which machines do I have?")).toContain("equipment_list")
  })

  it("offers memory proposals only after an explicit owner request", () => {
    expect(selectTools("I had a good day.")).not.toContain("memory_propose")
    expect(selectTools("What did I say about coffee?")).not.toContain("memory_propose")
    expect(selectTools("Remember that I prefer tea.")).toContain("memory_propose")
    expect(selectTools("Please save this about me.")).toContain("memory_propose")
    expect(selectTools("Kom ihåg att jag föredrar te.")).toContain("memory_propose")
    expect(selectTools("Spara det här om mig.")).toContain("memory_propose")
    expect(selectTools("Do not remember this.")).not.toContain("memory_propose")
    expect(selectTools("Spara inte det här.")).not.toContain("memory_propose")
    expect(selectTools("Remember that I prefer morning workouts.")).toEqual([
      "memory_search",
      "memory_propose",
      "memory_correct"
    ])
    expect(selectTools("Remember to start my workout at 18:00.")).not.toContain("memory_propose")
    expect(selectTools("Save this workout routine.")).toContain("routine_save")
    expect(selectTools("Save this workout routine.")).not.toContain("memory_propose")
  })

  it("offers a reviewable memory proposal for explicit preference feedback", () => {
    expect(selectTools("I now prefer evening workouts.")).toEqual(
      expect.arrayContaining(["workout_history", "memory_propose"])
    )
    expect(selectTools("From now on, remind me 30 minutes before events.")).toEqual(
      expect.arrayContaining(["reminder_create", "memory_propose"])
    )
    expect(selectTools("Framöver föredrar jag kvällsträning.")).toContain("memory_propose")
    expect(selectTools("Morning workouts went well today.")).not.toContain("memory_propose")
  })

  it.each([
    "I don't want to do warm-ups.",
    "I don’t wanna do warm up.",
    "I do not want warm ups in my workouts.",
    "I want to skip the warm-up from now on.",
    "Jag vill inte göra uppvärmning.",
    "Jag vill hoppa över uppvärmningen framöver."
  ])("offers a reviewable memory proposal for an explicit negative preference: %s", (text) => {
    expect(selectTools(text)).toContain("memory_propose")
    expect(selectTools(text)).toContain("routine_get")
  })
})
