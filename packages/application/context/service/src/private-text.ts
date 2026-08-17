import type { CoreDatabase } from "@bob/db-types"
import type { DataProtection } from "@bob/policy-types/data-protection"
import type { OwnerDataKeyStoreAdapter } from "@bob/policy-types/owner-data-key"

import { makeOwnerDataKeyStore } from "@bob/policy-service/owner-data-key"

export interface PrivateTextReader {
  decrypt(
    ownerId: string,
    envelope: { readonly ciphertext: string; readonly iv: string }
  ): Promise<string>
}

export function makePrivateTextReader(
  database: CoreDatabase,
  protection: DataProtection,
  ownerDataKeys: OwnerDataKeyStoreAdapter = makeOwnerDataKeyStore(database, protection, {
    defaultTimeZone: "UTC"
  })
): PrivateTextReader {
  return {
    async decrypt(ownerId, envelope) {
      return protection.decryptText((await ownerDataKeys.load(ownerId)).key, envelope)
    }
  }
}
