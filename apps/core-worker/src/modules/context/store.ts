import type { ContextItem } from "@bob/contracts/agent"
import { and, desc, eq, isNull } from "drizzle-orm"
import { Context, Layer } from "effect"

import type { CoreDatabase } from "../../database.ts"
import { factEvidence, factRevisions, facts } from "../memory/schema.ts"
import { users } from "../conversations/schema.ts"
import type { DataProtection } from "../policy/data-protection.ts"

export interface ContextStore {
  build(ownerId: string, channelId: string): Promise<readonly ContextItem[]>
}

export const ContextStore = Context.Service<ContextStore>("bob/ContextStore")

export function boundContextItems(
  items: readonly ContextItem[],
  totalCharacterBudget: number,
  itemCharacterBudget: number
): readonly ContextItem[] {
  const bounded: ContextItem[] = []
  let remaining = totalCharacterBudget
  for (const item of items) {
    if (remaining <= 0) break
    const limit = Math.min(itemCharacterBudget, remaining)
    if (limit <= 0) break
    const text = item.text.slice(0, limit)
    if (text.length === 0) continue
    bounded.push({ ...item, text })
    remaining -= text.length
  }
  return Object.freeze(bounded)
}

export function makeContextStore(
  database: CoreDatabase,
  protection: DataProtection,
  options: {
    readonly profileCharacterBudget?: number
    readonly totalCharacterBudget?: number
    readonly itemCharacterBudget?: number
  }
): ContextStore {
  const profileCharacterBudget = options.profileCharacterBudget ?? 3_600
  const totalCharacterBudget = options.totalCharacterBudget ?? 6_000
  const itemCharacterBudget = options.itemCharacterBudget ?? 1_200

  async function ownerKey(ownerId: string): Promise<CryptoKey> {
    const [owner] = await database.select().from(users).where(eq(users.id, ownerId)).limit(1)
    if (
      owner?.wrappedDataKey === null ||
      owner?.wrappedDataKey === undefined ||
      owner.wrappedDataKeyIv === null ||
      owner.wrappedDataKeyIv === undefined ||
      owner.dataKeyVersion === null ||
      owner.dataKeyVersion === undefined
    ) {
      throw new Error("Owner data key is unavailable")
    }
    return protection.unwrapDataKey({
      ciphertext: owner.wrappedDataKey,
      iv: owner.wrappedDataKeyIv,
      version: owner.dataKeyVersion
    })
  }

  return {
    async build(ownerId, _channelId) {
      const key = await ownerKey(ownerId)
      const profileRows = await database
        .select({
          revision: factRevisions,
          factId: facts.id,
          sourceType: factEvidence.sourceType,
          sourceId: factEvidence.sourceId
        })
        .from(facts)
        .innerJoin(factRevisions, eq(facts.currentRevisionId, factRevisions.id))
        .leftJoin(factEvidence, eq(factEvidence.revisionId, factRevisions.id))
        .where(
          and(
            eq(facts.userId, ownerId),
            eq(factRevisions.verificationStatus, "confirmed"),
            eq(factRevisions.modelEligible, true),
            isNull(factRevisions.validTo)
          )
        )
        .orderBy(desc(factRevisions.importance))

      const profile: ContextItem[] = []
      let usedCharacters = 0
      for (const row of profileRows) {
        const text = await protection.decryptText(key, {
          ciphertext: row.revision.canonicalTextCiphertext,
          iv: row.revision.canonicalTextIv
        })
        if (usedCharacters + text.length > profileCharacterBudget) continue
        usedCharacters += text.length
        profile.push({
          kind: "profile",
          text,
          instruction: false,
          conflict: false,
          sources: [
            {
              sourceId: row.sourceId ?? row.revision.id,
              sourceLabel: `${row.sourceType ?? "fact"} ${row.revision.observedAt.slice(0, 10)}`,
              occurredAt: row.revision.observedAt
            }
          ]
        } as ContextItem)
      }
      return boundContextItems(profile, totalCharacterBudget, itemCharacterBudget)
    }
  }
}

export function contextStoreLayer(store: ContextStore) {
  return Layer.succeed(ContextStore, store)
}
