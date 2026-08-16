import { and, eq, isNull } from "drizzle-orm"
import { Context, Layer } from "effect"

import type { CoreDatabase } from "../../database.ts"
import type { DataProtection } from "./data-protection.ts"

import { users } from "../conversations/schema.ts"

export interface OwnerDataKey {
  readonly key: CryptoKey
  readonly version: number
}

export interface OwnerDataKeyStore {
  load(ownerId: string): Promise<OwnerDataKey>
  ensure(ownerId: string): Promise<OwnerDataKey>
}

export const OwnerDataKeyStore = Context.Service<OwnerDataKeyStore>("bob/OwnerDataKeyStore")

export interface OwnerDataKeyStoreOptions {
  readonly defaultTimeZone: string
  readonly defaultLocale?: string
  readonly defaultHourCycle?: "auto" | "h12" | "h23"
  readonly now?: () => Date
}

export function makeOwnerDataKeyStore(
  database: CoreDatabase,
  protection: DataProtection,
  options: OwnerDataKeyStoreOptions
): OwnerDataKeyStore {
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
    const [owner] = await database
      .select({
        wrappedDataKey: users.wrappedDataKey,
        wrappedDataKeyIv: users.wrappedDataKeyIv,
        dataKeyVersion: users.dataKeyVersion
      })
      .from(users)
      .where(eq(users.id, ownerId))
      .limit(1)
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
    const [owner] = await database
      .select({ wrappedDataKey: users.wrappedDataKey })
      .from(users)
      .where(eq(users.id, ownerId))
      .limit(1)
    if (owner?.wrappedDataKey != null) return read(ownerId)

    const created = await protection.createWrappedDataKey()
    const at = now().toISOString()
    if (owner === undefined) {
      await database
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
    } else {
      await database
        .update(users)
        .set({
          wrappedDataKey: created.wrapped.ciphertext,
          wrappedDataKeyIv: created.wrapped.iv,
          dataKeyVersion: created.wrapped.version,
          updatedAt: at
        })
        .where(and(eq(users.id, ownerId), isNull(users.wrappedDataKey)))
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

export function ownerDataKeyStoreLayer(store: OwnerDataKeyStore) {
  return Layer.succeed(OwnerDataKeyStore, store)
}
