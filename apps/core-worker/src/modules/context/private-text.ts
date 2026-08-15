import { eq } from "drizzle-orm"

import type { CoreDatabase } from "../../database.ts"
import type { DataProtection } from "../policy/data-protection.ts"

import { users } from "../conversations/schema.ts"

export interface PrivateTextReader {
  decrypt(
    ownerId: string,
    envelope: { readonly ciphertext: string; readonly iv: string }
  ): Promise<string>
}

export function makePrivateTextReader(
  database: CoreDatabase,
  protection: DataProtection
): PrivateTextReader {
  const keys = new Map<string, Promise<CryptoKey>>()
  const ownerKey = (ownerId: string): Promise<CryptoKey> => {
    const cached = keys.get(ownerId)
    if (cached !== undefined) return cached
    const loaded = (async () => {
      const [owner] = await database.select().from(users).where(eq(users.id, ownerId)).limit(1)
      if (
        owner?.wrappedDataKey == null ||
        owner.wrappedDataKeyIv == null ||
        owner.dataKeyVersion == null
      ) {
        throw new Error("Owner data key is unavailable")
      }
      return protection.unwrapDataKey({
        ciphertext: owner.wrappedDataKey,
        iv: owner.wrappedDataKeyIv,
        version: owner.dataKeyVersion
      })
    })()
    keys.set(ownerId, loaded)
    return loaded
  }
  return {
    async decrypt(ownerId, envelope) {
      return protection.decryptText(await ownerKey(ownerId), envelope)
    }
  }
}
