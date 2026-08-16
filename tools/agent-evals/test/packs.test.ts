import { describe, expect, it } from "vitest"

import { coreEvaluationPack, coreEvaluationProfile } from "../src/evaluation-packs/core.ts"
import {
  connectionsEvaluationPack,
  reminderEvaluationPack,
  trainingEvaluationPack
} from "../src/evaluation-packs/optional.ts"
import { transitionalEvaluationProfile } from "../src/evaluation-packs/transitional.ts"
import { evaluatePack, evaluateProfile, makeEvaluationProfile } from "../src/packs.ts"

describe("evaluation packs", () => {
  it("gates General Agent Core without optional domain packs", async () => {
    const report = await evaluateProfile(coreEvaluationProfile)

    expect(report.passed).toBe(true)
    expect(report.packs.map((pack) => pack.packId)).toEqual(["core"])
    expect(report.packs[0]?.reports.flatMap((item) => item.results)).toHaveLength(7)
  })

  it("gates every selected optional pack independently", async () => {
    const reports = await Promise.all(
      [reminderEvaluationPack, trainingEvaluationPack, connectionsEvaluationPack].map(evaluatePack)
    )

    expect(reports.map((report) => [report.packId, report.passed])).toEqual([
      ["reminders", true],
      ["training", true],
      ["connections", true]
    ])
  })

  it("assigns each committed case to exactly one pack", () => {
    const caseIds = transitionalEvaluationProfile.packs.flatMap((pack) =>
      pack.shards.flatMap((shard) => shard.caseIds)
    )

    expect(caseIds).toHaveLength(23)
    expect(new Set(caseIds).size).toBe(caseIds.length)
  })

  it("rejects duplicate pack ownership in one profile", () => {
    expect(() =>
      makeEvaluationProfile("invalid", [coreEvaluationPack, coreEvaluationPack])
    ).toThrow("evaluation_pack_id_duplicate")
  })

  it("rejects duplicate case ownership across packs", () => {
    expect(() =>
      makeEvaluationProfile("invalid", [
        coreEvaluationPack,
        { id: "other", shards: coreEvaluationPack.shards }
      ])
    ).toThrow("evaluation_case_owner_duplicate")
  })

  it("keeps optional pack removal local to profile composition", () => {
    const profile = makeEvaluationProfile("without-training", [
      coreEvaluationPack,
      reminderEvaluationPack,
      connectionsEvaluationPack
    ])

    expect(profile.packs.map((pack) => pack.id)).toEqual(["core", "reminders", "connections"])
  })

  it("rejects a metric from a later schema version", async () => {
    const shard = coreEvaluationPack.shards[0]!
    await expect(
      evaluatePack({
        id: "invalid-coverage",
        shards: [{ ...shard, requiredMetrics: ["casePassRate", "proactiveRecall"] }]
      })
    ).rejects.toThrow("evaluation_pack_metric_not_supported")
  })
})
