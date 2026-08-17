import { boundContextItems } from "@bob/context-service/store"
import { decideCandidate, deriveMemoryPolicy } from "@bob/memory-service/rules"
import {
  classifyDeterministicCommand,
  isArtifactResendRequest,
  resolveShortReply,
  urgentSafetyResponse
} from "@bob/policy-service/rules"
import {
  isSettingsMutationRequest,
  settingsUpdateMatchesRequest
} from "@bob/settings-service/rules"
import { describe, expect, it } from "vitest"

describe("deterministic domain rules", () => {
  it("does not bind an ambiguous done reply", () => {
    const expiresAt = "2026-08-12T00:00:00.000Z"
    expect(
      resolveShortReply(
        "done",
        [
          { id: "1", command: "done", targetType: "record", targetId: "1", expiresAt },
          { id: "2", command: "done", targetType: "task", targetId: "2", expiresAt }
        ],
        new Date("2026-08-11T00:00:00.000Z")
      ).kind
    ).toBe("ambiguous")
  })

  it.each([
    ["HJÄLP", "help"],
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
    "Please show me that artifact again.",
    "Skicka planen igen",
    "Visa den igen"
  ])("recognizes an artifact resend request: %s", (text) => {
    expect(isArtifactResendRequest(text)).toBe(true)
  })

  it("does not capture a normal request as an artifact resend", () => {
    expect(isArtifactResendRequest("Make me another plan")).toBe(false)
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
})
