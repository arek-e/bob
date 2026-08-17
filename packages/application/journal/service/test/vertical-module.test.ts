import type { DeploymentProfileContext } from "@bob/deployment-profile-types/runtime"

import { describe, expect, it } from "vitest"

import { journalVerticalModule } from "../src/vertical-module.ts"

interface JournalBindings {
  readonly UI_BASE_URL?: string
}

function context(bindings: JournalBindings): DeploymentProfileContext {
  const fixture = { bindings, database: {} }
  // SAFETY: This focused test does not execute the database Adapter.
  return fixture as DeploymentProfileContext
}

describe("Journal Vertical Module", () => {
  it("prepares its complete privacy and runtime contribution set from owned configuration", () => {
    const prepared = journalVerticalModule.prepare(context({ UI_BASE_URL: "https://bob.example/" }))

    expect(prepared).toMatchObject({
      id: "journal",
      capability: { id: "journal" },
      legacyArtifactReaders: [],
      deliveryTargets: []
    })
    expect(prepared.evidenceSources.map((source) => source.id)).toEqual(["journal_evidence"])
    expect(prepared.runtimeModules.conversations.map((workflow) => workflow.id)).toEqual([
      "journal-handoff"
    ])
    expect(prepared.runtimeModules.ownerRoutes.map((route) => route.id)).toEqual([
      "journal-owner-routes"
    ])
    expect(prepared.runtimeModules.scheduledTasks).toEqual([])
    expect(prepared.toolAdapters.map((adapter) => adapter.capabilityId)).toEqual(["journal"])

    expect(() => journalVerticalModule.prepare(context({ UI_BASE_URL: "not a URL" }))).toThrow()
  })
})
