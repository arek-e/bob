export interface ReviewedAgentExperience {
  readonly id: string
  readonly version: number
  readonly text: string
  readonly contentHash: string
  readonly evidenceSourceIds: readonly string[]
  readonly reviewedAt: string
  readonly reviewReference: string
}

export interface AgentExperienceRegistry {
  readonly profileId: string
  readonly entries: readonly ReviewedAgentExperience[]
}

/**
 * Agent experience has a review-only composition path.
 * It cannot enter the Owner fact proposal or confirmation workflow.
 */
export function makeAgentExperienceRegistry(
  profileId: string,
  entries: readonly ReviewedAgentExperience[]
): AgentExperienceRegistry {
  if (profileId.trim().length === 0) throw new Error("Agent experience profile ID is required")
  const ids = new Set<string>()
  for (const entry of entries) {
    if (entry.id.trim().length === 0 || entry.version < 1) {
      throw new Error("Reviewed Agent experience identity is invalid")
    }
    if (ids.has(entry.id)) throw new Error(`Duplicate Agent experience ${entry.id}`)
    if (
      entry.text.trim().length === 0 ||
      entry.contentHash.trim().length === 0 ||
      entry.evidenceSourceIds.length === 0 ||
      entry.reviewReference.trim().length === 0
    ) {
      throw new Error(`Agent experience ${entry.id} lacks review evidence`)
    }
    ids.add(entry.id)
  }
  return Object.freeze({
    profileId,
    entries: Object.freeze(
      entries.map((entry) =>
        Object.freeze({
          ...entry,
          evidenceSourceIds: Object.freeze([...entry.evidenceSourceIds])
        })
      )
    )
  })
}
