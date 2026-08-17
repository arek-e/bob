import type {
  EvidenceReference,
  EvidenceSourceAdapter,
  EvidenceSourceRegistry
} from "@bob/memory-types/evidence"

export type {
  EvidenceReference,
  EvidenceSourceAdapter,
  EvidenceSourceRegistry,
  MemoryClass,
  VerifiedEvidence
} from "@bob/memory-types/evidence"

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
