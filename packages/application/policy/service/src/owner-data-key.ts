import type { CoreDatabase } from "@bob/db-types"
import type { DataProtection } from "@bob/policy-types/data-protection"

import { users } from "@bob/db-service/schema/conversations"
import {
  OwnerDataKeyStore,
  type OwnerDataKeyStoreAdapter,
  OwnerDataKeyStoreError,
  type OwnerDataKey,
  type OwnerDataKeyStoreOptions
} from "@bob/policy-types/owner-data-key"
import { liftPromiseAdapter } from "@bob/shared-types/effect-adapter"
import { and, eq, isNull } from "drizzle-orm"
import { Effect, Layer } from "effect"

export {
  OwnerDataKeyStore,
  type OwnerDataKeyStoreAdapter,
  type OwnerDataKey,
  type OwnerDataKeyStoreOptions
} from "@bob/policy-types/owner-data-key"

export function makeOwnerDataKeyStore(
  database: CoreDatabase,
  protection: DataProtection,
  options: OwnerDataKeyStoreOptions
): OwnerDataKeyStoreAdapter {
  const now = options.now ?? (() => new Date())
  const loadedKeys = new Map<string, OwnerDataKey>()
  const pendingLoads = new Map<string, Promise<OwnerDataKey>>()
  const pendingEnsures = new Map<string, Promise<OwnerDataKey>>()

  function cached(
    ownerId: string,
    pendingOperations: Map<string, Promise<OwnerDataKey>>,
    operation: () => Promise<OwnerDataKey>
  ): Promise<OwnerDataKey> {
    const loaded = loadedKeys.get(ownerId)
    if (loaded !== undefined) return Promise.resolve(loaded)
    const existing = pendingOperations.get(ownerId)
    if (existing !== undefined) return existing

    const pending = operation()
      .then((value) => {
        loadedKeys.set(ownerId, value)
        return value
      })
      .finally(() => {
        if (pendingOperations.get(ownerId) === pending) pendingOperations.delete(ownerId)
      })
    pendingOperations.set(ownerId, pending)
    return pending
  }

  async function read(ownerId: string): Promise<OwnerDataKey> {
    const [owner] = await Effect.runPromise(
      database
        .select({
          wrappedDataKey: users.wrappedDataKey,
          wrappedDataKeyIv: users.wrappedDataKeyIv,
          dataKeyVersion: users.dataKeyVersion
        })
        .from(users)
        .where(eq(users.id, ownerId))
        .limit(1)
    )
    if (
      owner?.wrappedDataKey == null ||
      owner.wrappedDataKeyIv == null ||
      owner.dataKeyVersion == null
    ) {
      throw new Error("Owner data key is unavailable")
    }
    return {
      key: await protection.unwrapDataKey({
        ciphertext: owner.wrappedDataKey,
        iv: owner.wrappedDataKeyIv,
        version: owner.dataKeyVersion
      }),
      version: owner.dataKeyVersion
    }
  }

  async function provision(ownerId: string): Promise<OwnerDataKey> {
    const [owner] = await Effect.runPromise(
      database
        .select({ wrappedDataKey: users.wrappedDataKey })
        .from(users)
        .where(eq(users.id, ownerId))
        .limit(1)
    )
    if (owner?.wrappedDataKey != null) return read(ownerId)

    const created = await protection.createWrappedDataKey()
    const at = now().toISOString()
    if (owner === undefined) {
      await Effect.runPromise(
        database
          .insert(users)
          .values({
            id: ownerId,
            timeZone: options.defaultTimeZone,
            locale: options.defaultLocale ?? "en",
            hourCycle: options.defaultHourCycle ?? "auto",
            wrappedDataKey: created.wrapped.ciphertext,
            wrappedDataKeyIv: created.wrapped.iv,
            dataKeyVersion: created.wrapped.version,
            createdAt: at,
            updatedAt: at
          })
          .onConflictDoNothing()
      )
    } else {
      await Effect.runPromise(
        database
          .update(users)
          .set({
            wrappedDataKey: created.wrapped.ciphertext,
            wrappedDataKeyIv: created.wrapped.iv,
            dataKeyVersion: created.wrapped.version,
            updatedAt: at
          })
          .where(and(eq(users.id, ownerId), isNull(users.wrappedDataKey)))
      )
    }
    return read(ownerId)
  }

  return {
    load(ownerId) {
      return cached(ownerId, pendingLoads, () => read(ownerId))
    },
    ensure(ownerId) {
      return cached(ownerId, pendingEnsures, () => provision(ownerId))
    }
  }
}

export function ownerDataKeyStoreLayer(store: OwnerDataKeyStoreAdapter) {
  return Layer.succeed(
    OwnerDataKeyStore,
    liftPromiseAdapter(
      store,
      (operation, cause) => new OwnerDataKeyStoreError({ operation: String(operation), cause })
    )
  )
}
