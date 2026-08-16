import {
  decodeLegacyMemoryValue,
  decodeMemoryValue,
  decodeStoredMemoryValue,
  encodeMemoryValue,
  encryptedMemoryValue,
  plainMemoryValue,
  readMemoryValue
} from "@bob/core-service/memory/value-envelope"
import { createDataProtection } from "@bob/core-service/policy/data-protection"
import { describe, expect, it } from "vitest"

function key(byte: number): string {
  return Buffer.from(new Uint8Array(32).fill(byte)).toString("hex")
}

describe("memory value envelopes", () => {
  it("keeps a real JSON null as a plain value", () => {
    const encoded = encodeMemoryValue(plainMemoryValue(null))

    expect(decodeMemoryValue(encoded)).toEqual({ version: 1, kind: "plain", value: null })
    expect(
      decodeLegacyMemoryValue({
        valueJson: "null",
        valueCiphertext: null,
        valueIv: null,
        keyVersion: 4
      })
    ).toEqual({ version: 1, kind: "plain", value: null })
  })

  it.each([
    { valueCiphertext: "ciphertext", valueIv: null },
    { valueCiphertext: null, valueIv: "iv" }
  ])("rejects incomplete legacy encryption fields", ({ valueCiphertext, valueIv }) => {
    expect(() =>
      decodeLegacyMemoryValue({ valueJson: "null", valueCiphertext, valueIv, keyVersion: 1 })
    ).toThrow("incomplete encryption fields")
  })

  it("uses legacy columns only for the migration-window marker", () => {
    const legacy = {
      valueJson: '"legacy"',
      valueCiphertext: null,
      valueIv: null,
      keyVersion: 1
    }

    expect(decodeStoredMemoryValue({ envelope: "", legacy })).toEqual({
      version: 1,
      kind: "plain",
      value: "legacy"
    })
    expect(() => decodeStoredMemoryValue({ envelope: " ", legacy })).toThrow()
  })

  it("keeps the stored key version while reading with the current owner key", async () => {
    const protection = createDataProtection({ 1: key(1) }, 1, key(2))
    const owner = await protection.createWrappedDataKey()
    const encrypted = await protection.encryptText(owner.key, JSON.stringify({ note: "private" }))
    const envelope = encryptedMemoryValue(encrypted, 7)

    expect(decodeMemoryValue(encodeMemoryValue(envelope))).toEqual(envelope)
    await expect(
      readMemoryValue(envelope, { key: owner.key, version: 8 }, protection)
    ).resolves.toEqual({ note: "private" })
    await expect(
      readMemoryValue(envelope, { key: owner.key, version: 6 }, protection)
    ).rejects.toThrow("newer owner data key version")
  })

  it("rejects unknown envelope versions and malformed encrypted values", () => {
    expect(() => decodeMemoryValue('{"version":2,"kind":"plain","value":null}')).toThrow()
    expect(() =>
      decodeMemoryValue('{"version":1,"kind":"encrypted","ciphertext":"x","keyVersion":1}')
    ).toThrow()
  })
})
