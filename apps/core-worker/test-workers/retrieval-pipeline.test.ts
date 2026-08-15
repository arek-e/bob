import { applyD1Migrations, reset } from "cloudflare:test"
import { env } from "cloudflare:workers"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createCoreDatabase } from "../src/database.ts"
import { makeRetrievalPipeline, type RetrievalRequest } from "../src/modules/retrieval/pipeline.ts"
import { retrievalProjection } from "../src/modules/retrieval/projection.ts"
import { searchDocuments } from "../src/modules/retrieval/schema.ts"
import { decodeTestMigrations } from "./migrations.ts"

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database
      TEST_MIGRATIONS: string
    }
  }
}

const ownerId = "00000000-0000-4000-8000-000000000901"
const otherOwnerId = "00000000-0000-4000-8000-000000000902"
const referenceTime = "2026-08-11T10:00:00.000Z"

function projection(
  id: string,
  text: string,
  overrides: Partial<Parameters<typeof retrievalProjection>[0]> = {}
) {
  return retrievalProjection({
    id,
    ownerId,
    sourceType: "fact_revision",
    sourceId: `source-${id}`,
    memoryClass: "owner_fact",
    text,
    searchText: text,
    sourceLabel: `Owner record ${id}`,
    occurredAt: "2026-08-10T10:00:00.000Z",
    validFrom: "2026-08-10T10:00:00.000Z",
    importance: 500,
    sensitivity: "normal",
    modelEligible: true,
    channelEligible: true,
    createdAt: "2026-08-10T10:00:00.000Z",
    ...overrides
  })
}

function query(text: string, overrides: Partial<RetrievalRequest> = {}) {
  return {
    ownerId,
    query: text,
    channel: true,
    referenceTime,
    timeZone: "Europe/Stockholm",
    ...overrides
  }
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, decodeTestMigrations(env.TEST_MIGRATIONS))
})

afterEach(async () => {
  await reset()
})

describe("Retrieval pipeline", () => {
  it("returns typed abstention reasons for absent and weak evidence", async () => {
    const database = createCoreDatabase(env.DB)
    const retrieval = makeRetrievalPipeline(database)

    await expect(retrieval.retrieve(query("and the"))).resolves.toMatchObject({
      status: "abstain",
      reason: "no_query_terms"
    })
    await expect(retrieval.retrieve(query("missing"))).resolves.toMatchObject({
      status: "abstain",
      reason: "no_candidates"
    })

    await database
      .insert(searchDocuments)
      .values(projection("00000000-0000-4000-8000-000000000911", "Breakfast was early"))
    await expect(retrieval.retrieve(query("breakfast allergy current"))).resolves.toMatchObject({
      status: "abstain",
      reason: "no_relevant_candidates",
      candidateCount: 1
    })
  })

  it("isolates owners and channel disclosure before reading", async () => {
    const database = createCoreDatabase(env.DB)
    await database.insert(searchDocuments).values([
      projection("00000000-0000-4000-8000-000000000921", "Favorite tea is mint"),
      projection("00000000-0000-4000-8000-000000000922", "Favorite tea is hidden", {
        channelEligible: false
      }),
      projection("00000000-0000-4000-8000-000000000923", "Favorite tea is foreign", {
        ownerId: otherOwnerId
      })
    ])
    const retrieval = makeRetrievalPipeline(database)

    const result = await retrieval.retrieve(query("favorite tea"))
    expect(result).toMatchObject({
      status: "supported",
      items: [{ text: "Favorite tea is mint" }]
    })
    await expect(retrieval.retrieve(query("hidden"))).resolves.toMatchObject({
      status: "abstain",
      reason: "policy_filtered",
      items: []
    })
  })

  it("selects historical fact validity without treating supersession as deletion", async () => {
    const database = createCoreDatabase(env.DB)
    await database.insert(searchDocuments).values([
      projection("00000000-0000-4000-8000-000000000931", "Desk was upstairs", {
        sourceId: "desk-old",
        conflictKey: "desk",
        validFrom: "2025-01-01T00:00:00.000Z",
        validTo: "2026-01-01T00:00:00.000Z"
      }),
      projection("00000000-0000-4000-8000-000000000932", "Desk is downstairs", {
        sourceId: "desk-current",
        conflictKey: "desk",
        validFrom: "2026-01-01T00:00:00.000Z"
      })
    ])
    const retrieval = makeRetrievalPipeline(database)

    await expect(retrieval.retrieve(query("desk"))).resolves.toMatchObject({
      status: "supported",
      items: [{ sourceId: "desk-current", conflict: false }]
    })
    await expect(retrieval.retrieve(query("desk as of 2025-06-01"))).resolves.toMatchObject({
      status: "supported",
      items: [{ sourceId: "desk-old", conflict: false }]
    })
  })

  it("returns complete unresolved conflict groups or omits the group", async () => {
    const database = createCoreDatabase(env.DB)
    await database.insert(searchDocuments).values([
      projection("00000000-0000-4000-8000-000000000941", "Desk is upstairs", {
        sourceId: "desk-a",
        conflictKey: "desk",
        contentHash: "a"
      }),
      projection("00000000-0000-4000-8000-000000000942", "Desk is downstairs", {
        sourceId: "desk-b",
        conflictKey: "desk",
        contentHash: "b"
      })
    ])
    const retrieval = makeRetrievalPipeline(database)

    await expect(retrieval.retrieve(query("desk"))).resolves.toMatchObject({
      status: "supported",
      items: [
        { sourceId: "desk-a", conflict: true },
        { sourceId: "desk-b", conflict: true }
      ]
    })
    await expect(
      retrieval.retrieve(query("desk", { totalCharacterBudget: 20, itemCharacterBudget: 20 }))
    ).resolves.toMatchObject({ status: "abstain", reason: "reading_budget_exhausted" })
  })

  it("uses owner-local dates for episode retrieval", async () => {
    const database = createCoreDatabase(env.DB)
    await database.insert(searchDocuments).values([
      projection("00000000-0000-4000-8000-000000000951", "Breakfast was oatmeal", {
        memoryClass: "owner_episode",
        sourceType: "episode",
        occurredAt: "2026-08-10T06:00:00.000Z"
      }),
      projection("00000000-0000-4000-8000-000000000952", "Breakfast was toast", {
        memoryClass: "owner_episode",
        sourceType: "episode",
        occurredAt: "2026-08-09T06:00:00.000Z"
      })
    ])
    const retrieval = makeRetrievalPipeline(database)

    await expect(retrieval.retrieve(query("breakfast yesterday"))).resolves.toMatchObject({
      status: "supported",
      items: [{ text: "Breakfast was oatmeal" }]
    })
  })

  it("keeps the new FTS projection current after an index update", async () => {
    const database = createCoreDatabase(env.DB)
    const id = "00000000-0000-4000-8000-000000000961"
    await database.insert(searchDocuments).values(projection(id, "Favorite drink is tea"))
    const retrieval = makeRetrievalPipeline(database)

    await expect(retrieval.retrieve(query("tea"))).resolves.toMatchObject({ status: "supported" })
    await database
      .update(searchDocuments)
      .set({ text: "Favorite drink is coffee", searchText: "favorite drink coffee" })
    await expect(retrieval.retrieve(query("tea"))).resolves.toMatchObject({
      status: "abstain",
      reason: "no_candidates"
    })
    await expect(retrieval.retrieve(query("coffee"))).resolves.toMatchObject({
      status: "supported",
      items: [{ text: "Favorite drink is coffee" }]
    })
  })
})
