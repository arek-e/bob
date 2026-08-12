import { describe, expect, it } from "vitest"

import { renderArtifact } from "../src/modules/artifacts/render.ts"

describe("artifact rendering", () => {
  it("renders a training plan as stable copyable text", () => {
    const artifact = {
      kind: "training_plan" as const,
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
})
