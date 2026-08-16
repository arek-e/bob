import { applyD1Migrations, reset } from "cloudflare:test"
import { env } from "cloudflare:workers"
import { eq } from "drizzle-orm"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createCoreDatabase } from "../src/database.ts"
import { users } from "../src/modules/conversations/schema.ts"
import { createDataProtection } from "../src/modules/policy/data-protection.ts"
import { makeOwnerDataKeyStore } from "../src/modules/policy/owner-data-key.ts"
import { decodeTestMigrations } from "./migrations.ts"

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database
      TEST_MIGRATIONS: string
    }
  }
}

const ownerId = "00000000-0000-4000-8000-000000000001"
const at = "2026-08-16T10:00:00.000Z"

function key(byte: number): string {
  let binary = ""
  for (const value of new Uint8Array(32).fill(byte)) binary += String.fromCharCode(value)
  return btoa(binary)
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, decodeTestMigrations(env.TEST_MIGRATIONS))
})

afterEach(async () => {
  await reset()
})

describe("Owner data key store", () => {
  it("does not create an Owner during a read", async () => {
    const database = createCoreDatabase(env.DB)
    const protection = createDataProtection({ 1: key(1) }, 1, key(2))
    const store = makeOwnerDataKeyStore(database, protection, {
      defaultTimeZone: "Europe/Stockholm"
    })

    await expect(store.load(ownerId)).rejects.toThrow("Owner data key is unavailable")
    await expect(
      database.select({ id: users.id }).from(users).where(eq(users.id, ownerId))
    ).resolves.toEqual([])
  })

  it("retries a failed load and provisions one shared key", async () => {
    const database = createCoreDatabase(env.DB)
    const protection = createDataProtection({ 1: key(1) }, 1, key(2))
    const store = makeOwnerDataKeyStore(database, protection, {
      defaultTimeZone: "Europe/Stockholm",
      now: () => new Date(at)
    })

    await expect(store.load(ownerId)).rejects.toThrow("Owner data key is unavailable")
    const [first, second] = await Promise.all([store.ensure(ownerId), store.ensure(ownerId)])

    expect(first).toEqual(second)
    expect(first.version).toBe(1)
    await expect(
      database
        .select({
          id: users.id,
          timeZone: users.timeZone,
          dataKeyVersion: users.dataKeyVersion
        })
        .from(users)
        .where(eq(users.id, ownerId))
    ).resolves.toEqual([{ id: ownerId, timeZone: "Europe/Stockholm", dataKeyVersion: 1 }])
  })

  it("returns the stored key version instead of the active wrapping version", async () => {
    const database = createCoreDatabase(env.DB)
    const originalProtection = createDataProtection({ 1: key(1) }, 1, key(2))
    const original = await originalProtection.createWrappedDataKey()
    await database.insert(users).values({
      id: ownerId,
      timeZone: "Europe/Stockholm",
      wrappedDataKey: original.wrapped.ciphertext,
      wrappedDataKeyIv: original.wrapped.iv,
      dataKeyVersion: original.wrapped.version,
      createdAt: at,
      updatedAt: at
    })

    const currentProtection = createDataProtection({ 1: key(1), 2: key(3) }, 2, key(2))
    const store = makeOwnerDataKeyStore(database, currentProtection, {
      defaultTimeZone: "Europe/Stockholm"
    })

    await expect(store.load(ownerId)).resolves.toMatchObject({ version: 1 })
  })
})
