import { describe, expect, it } from "vitest"

import { makeAgentExperienceRegistry } from "../src/modules/memory/agent-experience.ts"
import { makeEvidenceSourceRegistry } from "../src/modules/memory/evidence.ts"
import { makeReviewedSkillRegistry } from "../src/modules/skills/registry.ts"

describe("Memory class Modules", () => {
  it("rejects duplicate evidence ownership and unsupported sources", async () => {
    const adapter = {
      id: "records",
      sourceTypes: ["record"],
      verify: async () => undefined
    }
    expect(() => makeEvidenceSourceRegistry("core", [adapter, adapter])).toThrow("Duplicate")
    const registry = makeEvidenceSourceRegistry("core", [adapter])
    await expect(
      registry.verify({ ownerId: "owner", sourceType: "unknown", sourceId: "source" })
    ).rejects.toThrow("not supported")
  })

  it("composes a core-only evidence profile without Vertical Adapters", () => {
    const registry = makeEvidenceSourceRegistry("core", [
      { id: "conversation", sourceTypes: ["message"], verify: async () => undefined }
    ])
    expect(registry.profileId).toBe("core")
    expect(registry.adapters.map(({ id }) => id)).toEqual(["conversation"])
    expect(Object.isFrozen(registry.adapters)).toBe(true)
  })

  it("keeps Agent experience behind review evidence", () => {
    expect(() =>
      makeAgentExperienceRegistry("core", [
        {
          id: "retry-outcome",
          version: 1,
          text: "A reviewed workflow outcome.",
          contentHash: "sha256:experience",
          evidenceSourceIds: [],
          reviewedAt: "2026-08-15T10:00:00.000Z",
          reviewReference: "review:1"
        }
      ])
    ).toThrow("lacks review evidence")
    expect(makeAgentExperienceRegistry("core", []).entries).toEqual([])
  })

  it("keeps reviewed Skills immutable and without Tool authority", () => {
    const registry = makeReviewedSkillRegistry("core", [
      {
        id: "summarize",
        version: 1,
        instructions: "Summarize only approved records.",
        contentHash: "sha256:skill",
        reviewReference: "review:2"
      }
    ])
    expect(Object.isFrozen(registry.skills)).toBe(true)
    expect(registry.skills[0]).not.toHaveProperty("tools")
  })
})
