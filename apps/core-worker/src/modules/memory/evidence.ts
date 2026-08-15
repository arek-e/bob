import type { OriginClass } from "./rules.ts"

export type MemoryClass = "owner_fact" | "owner_episode" | "agent_experience"

const monthLabels = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec"
] as const

export function evidenceDate(value: string): string {
  const [year = "", month = "", day = ""] = value.slice(0, 10).split("-")
  return `${Number(day)} ${monthLabels[Number(month) - 1] ?? month} ${year}`
}

export interface EvidenceReference {
  readonly ownerId: string
  readonly sourceType: string
  readonly sourceId: string
}

export interface VerifiedEvidence {
  readonly sourceLabel: string
  readonly occurredAt?: string
  readonly contentHash: string
  readonly originClass: OriginClass
  readonly sensitivity: "normal" | "private" | "high"
  readonly confirmationAuthority: "owner_ui" | "completed_system_command" | "never"
  readonly disclosure: "model_and_channel" | "private"
}

export interface EvidenceSourceAdapter {
  readonly id: string
  readonly sourceTypes: readonly string[]
  verify(reference: EvidenceReference): Promise<VerifiedEvidence | undefined>
}

export interface EvidenceSourceRegistry {
  readonly profileId: string
  readonly adapters: readonly EvidenceSourceAdapter[]
  verify(reference: EvidenceReference): Promise<VerifiedEvidence>
}

export function makeEvidenceSourceRegistry(
  profileId: string,
  adapters: readonly EvidenceSourceAdapter[]
): EvidenceSourceRegistry {
  if (profileId.trim().length === 0) throw new Error("Evidence profile ID is required")
  const adapterByType = new Map<string, EvidenceSourceAdapter>()
  const ids = new Set<string>()
  const frozenAdapters = adapters.map((adapter) =>
    Object.freeze({ ...adapter, sourceTypes: Object.freeze([...adapter.sourceTypes]) })
  )
  for (const adapter of frozenAdapters) {
    if (adapter.id.trim().length === 0) throw new Error("Evidence source ID is required")
    if (ids.has(adapter.id)) throw new Error(`Duplicate evidence source Adapter ${adapter.id}`)
    ids.add(adapter.id)
    if (adapter.sourceTypes.length === 0) {
      throw new Error(`Evidence source Adapter ${adapter.id} owns no source types`)
    }
    for (const sourceType of adapter.sourceTypes) {
      if (adapterByType.has(sourceType)) {
        throw new Error(`Duplicate evidence source type ${sourceType}`)
      }
      adapterByType.set(sourceType, adapter)
    }
  }
  return Object.freeze({
    profileId,
    adapters: Object.freeze(frozenAdapters),
    async verify(reference: EvidenceReference) {
      const adapter = adapterByType.get(reference.sourceType)
      if (adapter === undefined) throw new Error("Memory evidence source type is not supported")
      const evidence = await adapter.verify(reference)
      if (evidence === undefined) {
        throw new Error("Memory evidence does not exist for the owner or origin")
      }
      return evidence
    }
  })
}
