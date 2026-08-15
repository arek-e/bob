import { describe, expect, it } from "vitest"

import { renderArtifact } from "../src/modules/artifacts/render.ts"
import { legacyTrainingArtifactReader } from "../src/modules/training/legacy-artifact.ts"

describe("artifact rendering", () => {
  it("renders a general plan as stable copyable text", () => {
    const artifact = {
      kind: "plan" as const,
      title: "Friday errands",
      durationMinutes: 45,
      sections: [{ heading: "Before lunch", items: ["Collect the parcel"] }]
    }

    expect(renderArtifact(artifact)).toBe(
      ["Friday errands", "Duration: 45 minutes", "", "Before lunch", "1. Collect the parcel"].join(
        "\n"
      )
    )
  })

  it("renders another plan as stable copyable text", () => {
    const artifact = {
      kind: "plan" as const,
      title: "Biceps · Thursday, August 13",
      durationMinutes: 50,
      sections: [
        {
          heading: "Workout",
          items: ["Incline dumbbell curl — 3 × 8–10", "Hammer curl — 3 × 10–12"]
        },
        {
          heading: "Notes",
          items: ["Start the first curl with a lighter set."]
        }
      ]
    }

    const first = renderArtifact(artifact)
    expect(first).toBe(
      [
        "Biceps · Thursday, August 13",
        "Duration: 50 minutes",
        "",
        "Workout",
        "1. Incline dumbbell curl — 3 × 8–10",
        "2. Hammer curl — 3 × 10–12",
        "",
        "Notes",
        "1. Start the first curl with a lighter set."
      ].join("\n")
    )
    expect(renderArtifact(artifact)).toBe(first)
    expect(first).not.toMatch(/Sources?:/u)
  })

  it("normalizes a stored legacy Training artifact in its owning Module", () => {
    expect(
      legacyTrainingArtifactReader.read({
        kind: "training_plan",
        title: "Stored plan",
        durationMinutes: 30,
        sections: [{ heading: "First", items: ["One stored item"] }]
      })
    ).toEqual({
      kind: "plan",
      title: "Stored plan",
      durationMinutes: 30,
      sections: [{ heading: "First", items: ["One stored item"] }]
    })
  })
})
