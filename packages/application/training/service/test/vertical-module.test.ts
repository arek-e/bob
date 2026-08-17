import type { DeploymentProfileContext } from "@bob/deployment-profile-types/runtime"

import { describe, expect, it } from "vitest"

import { legacyTrainingArtifactReader } from "../src/legacy-artifact.ts"
import { trainingVerticalModule } from "../src/vertical-module.ts"

const contextFixture = {
  bindings: {},
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
const context = contextFixture as DeploymentProfileContext

describe("Training Vertical Module", () => {
  it("prepares all Training runtime contributions", () => {
    const prepared = trainingVerticalModule.prepare(context)

    expect(prepared.id).toBe("training")
    expect(prepared.capability).toBe(trainingVerticalModule.capability)
    expect(prepared.evidenceSources.map(({ id }) => id)).toEqual(["training_evidence"])
    expect(prepared.legacyArtifactReaders).toHaveLength(1)
    expect(prepared.deliveryTargets).toEqual([])
    expect(prepared.runtimeModules.conversations.map(({ id }) => id)).toEqual(["training-safety"])
    expect(prepared.runtimeModules.ownerRoutes.map(({ id }) => id)).toEqual([
      "training-owner-routes"
    ])
    expect(prepared.runtimeModules.scheduledTasks).toEqual([])
    expect(prepared.toolAdapters).toHaveLength(1)
    expect(prepared.toolAdapters[0]?.capabilityId).toBe("training")
  })

  it("normalizes a stored legacy Training artifact", () => {
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
