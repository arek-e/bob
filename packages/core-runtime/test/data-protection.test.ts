import { describe, expect, it } from "vitest"

import { createDataProtection } from "../src/modules/policy/data-protection.ts"

describe("user data protection", () => {
  it("wraps one user key and encrypts private text", async () => {
    const kek = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)))
    const lookup = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)))
    const protection = createDataProtection({ 1: kek }, 1, lookup)
    const created = await protection.createWrappedDataKey()
    const encrypted = await protection.encryptText(created.key, "private journal text")
    expect(encrypted.ciphertext).not.toContain("private")
    const restoredKey = await protection.unwrapDataKey(created.wrapped)
    await expect(protection.decryptText(restoredKey, encrypted)).resolves.toBe(
      "private journal text"
    )
  })

  it("reads old records after KEK rotation and keeps stable lookup hashes", async () => {
    const oldKek = btoa(String.fromCharCode(...new Uint8Array(32).fill(3)))
    const newKek = btoa(String.fromCharCode(...new Uint8Array(32).fill(4)))
    const lookup = btoa(String.fromCharCode(...new Uint8Array(32).fill(5)))
    const before = createDataProtection({ 1: oldKek }, 1, lookup)
    const created = await before.createWrappedDataKey()
    const encrypted = await before.encryptText(created.key, "old record")
    const originalLookup = await before.hashLookup("+46700000000")

    const after = createDataProtection({ 1: oldKek, 2: newKek }, 2, lookup)
    const restored = await after.unwrapDataKey(created.wrapped)

    await expect(after.decryptText(restored, encrypted)).resolves.toBe("old record")
    await expect(after.hashLookup("+46700000000")).resolves.toBe(originalLookup)
    await expect(after.createWrappedDataKey()).resolves.toMatchObject({ wrapped: { version: 2 } })
  })
})
