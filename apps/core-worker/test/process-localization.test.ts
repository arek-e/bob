import { captureEvents } from "@bob/observability/testing"
import { describe, expect, it, vi } from "vitest"

import type { CoreBindings } from "../src/bindings.ts"
import type { CoreComposition } from "../src/composition.ts"

import { processInbound } from "../src/process-inbound.ts"
import { testFixture } from "./test-fixture.ts"

const ownerId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db91"
const channelId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db92"
const eventId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db90"

function localizedComposition(text: string) {
  const createOutbox = vi.fn(async () => "018e6f65-4d55-7a1b-8df4-4ee15ea1db95")
  const latestArtifact = vi.fn(
    async (): ReturnType<CoreComposition["services"]["artifacts"]["latest"]> => undefined
  )
  const command = text.toLowerCase() === "klart" ? "done" : "seen"
  // SAFETY: This controlled test fixture matches the asserted contract used by this test.
  const composition = testFixture<CoreComposition>({
    config: { UI_BASE_URL: "https://bob.example" },
    services: {
      events: captureEvents(),
      artifacts: { latest: latestArtifact },
      conversations: {
        claimInbound: vi.fn(async () => ({
          eventId,
          ownerId,
          channelId,
          messageId: "018e6f65-4d55-7a1b-8df4-4ee15ea1db93",
          text,
          correlationId: "018e6f65-4d55-7a1b-8df4-4ee15ea1db94"
        })),
        pendingBindings: vi.fn(async () => [
          {
            id: "binding",
            command,
            targetType: "reminder",
            targetId: "reminder",
            expiresAt: "2099-01-01T00:00:00.000Z"
          }
        ]),
        completeInbound: vi.fn(async () => undefined)
      },
      training: { stopActiveForSafety: vi.fn() },
      journal: {
        createHandoff: vi.fn(async () => ({ id: "private-link" }))
      },
      reminders: { applyBoundReply: vi.fn(async () => "applied") },
      delivery: {
        createOutbox,
        markEnqueued: vi.fn(async () => undefined)
      }
    }
  })
  return { composition, createOutbox, latestArtifact }
}

describe("deterministic Swedish replies", () => {
  it("returns the fixed Swedish response after a Swedish training safety stop", async () => {
    const { composition, createOutbox } = localizedComposition("Mitt knä gör ont efter setet.")
    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    const bindings = testFixture<CoreBindings>({
      OUTBOUND_QUEUE: { send: vi.fn(async () => undefined) }
    })

    await processInbound(eventId, bindings, composition)

    expect(composition.services.training.stopActiveForSafety).toHaveBeenCalledWith(
      ownerId,
      "pain_or_injury",
      expect.any(String)
    )
    expect(createOutbox).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Avsluta övningen nu. Öka inte vikten. Be en kvalificerad tränare eller vårdpersonal om hjälp."
      })
    )
  })

  it.each([
    ["HJÄLP", "Jag kan hjälpa dig att planera"],
    ["DAGBOK", "Öppna din privata dagbok: https://bob.example/journal/private-link"],
    ["KLART", "Påminnelsen är markerad som klar."],
    ["SETT", "Påminnelsen är markerad som sedd."],
    ["UPPREPA", "Öppna Bob för att se det senaste meddelandet."],
    ["VARFÖR", "Öppna Bob för att se den sparade orsaken"],
    ["PAUSA", "Den här interaktionen är pausad."],
    ["ÅNGRA", "Jag kan inte koppla ÅNGRA till en säker omvänd åtgärd."]
  ])("returns Swedish text for %s", async (text, expectedText) => {
    const { composition, createOutbox } = localizedComposition(text)
    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    const bindings = testFixture<CoreBindings>({
      OUTBOUND_QUEUE: { send: vi.fn(async () => undefined) }
    })

    await processInbound(eventId, bindings, composition)

    expect(createOutbox).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining(expectedText) })
    )
  })

  it("resends the latest artifact without regenerating it", async () => {
    const { composition, createOutbox, latestArtifact } =
      localizedComposition("Send the plan again")
    const renderedText = "Biceps · Thursday, August 13\n\nWorkout\n1. Hammer curl — 3 × 10–12"
    latestArtifact.mockResolvedValue({
      id: "018e6f65-4d55-7a1b-8df4-4ee15ea1db97",
      revision: 2,
      artifact: {
        kind: "plan",
        title: "Biceps · Thursday, August 13",
        durationMinutes: null,
        sections: [{ heading: "Workout", items: ["Hammer curl — 3 × 10–12"] }]
      },
      renderedText
    })
    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    const bindings = testFixture<CoreBindings>({
      OUTBOUND_QUEUE: { send: vi.fn(async () => undefined) }
    })

    await processInbound(eventId, bindings, composition)

    expect(createOutbox).toHaveBeenCalledWith(expect.objectContaining({ text: renderedText }))
    expect(latestArtifact).toHaveBeenCalledWith(ownerId, channelId)
  })
})
