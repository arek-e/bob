import type { CoreDatabase } from "@bob/core-types/database"

import type { DataProtection } from "../policy/data-protection.ts"
import type { OwnerDataKeyStore } from "../policy/owner-data-key.ts"

import { makeOwnerDataKeyStore } from "../policy/owner-data-key.ts"

export interface PrivateTextReader {
  decrypt(
    ownerId: string,
    envelope: { readonly ciphertext: string; readonly iv: string }
  ): Promise<string>
}

export function makePrivateTextReader(
  database: CoreDatabase,
  protection: DataProtection,
  ownerDataKeys: OwnerDataKeyStore = makeOwnerDataKeyStore(database, protection, {
    defaultTimeZone: "UTC"
  })
): PrivateTextReader {
  return {
    async decrypt(ownerId, envelope) {
      return protection.decryptText((await ownerDataKeys.load(ownerId)).key, envelope)
    }
  }
}
