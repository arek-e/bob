import { evaluateSuite, type EvaluationReport, type MetricName } from "./gate.ts"
import { loadEvaluationInputs } from "./io.ts"

export interface EvaluationPackShard {
  readonly suite: URL
  readonly candidates: URL
  readonly caseIds: readonly string[]
  readonly requiredMetrics: readonly MetricName[]
}

export interface EvaluationPack {
  readonly id: string
  readonly shards: readonly EvaluationPackShard[]
}

export interface EvaluationProfile {
  readonly id: string
  readonly packs: readonly EvaluationPack[]
}

export interface EvaluationPackReport {
  readonly packId: string
  readonly passed: boolean
  readonly reports: readonly EvaluationReport[]
  readonly failures: readonly string[]
}

export interface EvaluationProfileReport {
  readonly profileId: string
  readonly passed: boolean
  readonly packs: readonly EvaluationPackReport[]
  readonly failures: readonly string[]
}

export function makeEvaluationProfile(
  id: string,
  packs: readonly EvaluationPack[]
): EvaluationProfile {
  if (id.length === 0) throw new Error("evaluation_profile_id_empty")
  if (new Set(packs.map((pack) => pack.id)).size !== packs.length) {
    throw new Error("evaluation_pack_id_duplicate")
  }
  const caseIds = packs.flatMap((pack) => pack.shards.flatMap((shard) => shard.caseIds))
  if (new Set(caseIds).size !== caseIds.length) {
    throw new Error("evaluation_case_owner_duplicate")
  }
  return { id, packs: [...packs] }
}

export async function evaluatePack(pack: EvaluationPack): Promise<EvaluationPackReport> {
  if (pack.id.trim().length === 0) throw new Error("evaluation_pack_id_empty")
  if (pack.shards.length === 0) throw new Error("evaluation_pack_empty")
  const reports = await Promise.all(
    pack.shards.map(async (shard) => {
      if (shard.caseIds.length === 0) throw new Error("evaluation_pack_cases_empty")
      if (shard.requiredMetrics.length === 0) throw new Error("evaluation_pack_metrics_empty")
      if (new Set(shard.requiredMetrics).size !== shard.requiredMetrics.length) {
        throw new Error("evaluation_pack_metric_duplicate")
      }
      const { suite, candidates } = await loadEvaluationInputs(shard.suite, shard.candidates)
      const selected = new Set(shard.caseIds)
      if (selected.size !== shard.caseIds.length) throw new Error("evaluation_pack_case_duplicate")
      const cases = suite.cases.filter((item) => selected.has(item.id))
      if (cases.length !== selected.size) throw new Error("evaluation_pack_case_missing")
      return evaluateSuite(
        { ...suite, requiredMetrics: shard.requiredMetrics, cases },
        {
          ...candidates,
          candidates: candidates.candidates.filter((item) => selected.has(item.caseId))
        }
      )
    })
  )
  const failures = reports.flatMap((report) =>
    report.failures.map((failure) => `${report.suiteId}:${failure}`)
  )
  return { packId: pack.id, passed: failures.length === 0, reports, failures }
}

export async function evaluateProfile(
  profile: EvaluationProfile
): Promise<EvaluationProfileReport> {
  const reviewed = makeEvaluationProfile(profile.id, profile.packs)
  const packs = await Promise.all(reviewed.packs.map(evaluatePack))
  const failures = packs.flatMap((pack) =>
    pack.failures.map((failure) => `${pack.packId}:${failure}`)
  )
  return { profileId: reviewed.id, passed: failures.length === 0, packs, failures }
}
