import type { DataProtection, EncryptedText } from "@bob/policy-types/data-protection"
import type { OwnerDataKey } from "@bob/policy-types/owner-data-key"

import { Schema } from "effect"

const MemoryValueEnvelopeSchema = Schema.Union([
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal("plain"),
    value: Schema.Json
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal("encrypted"),
    ciphertext: Schema.String,
    iv: Schema.String,
    keyVersion: Schema.Int.check(Schema.isGreaterThan(0))
  })
])

export type MemoryValueEnvelope = typeof MemoryValueEnvelopeSchema.Type

export interface LegacyMemoryValue {
  readonly valueJson: string
  readonly valueCiphertext: string | null
  readonly valueIv: string | null
  readonly keyVersion: number
}

export interface StoredMemoryValue {
  readonly envelope: string
  readonly legacy: LegacyMemoryValue
}

function decodeJson(value: string): typeof Schema.Json.Type {
  return Schema.decodeUnknownSync(Schema.Json)(JSON.parse(value))
}

export function plainMemoryValue(value: typeof Schema.Json.Type): MemoryValueEnvelope {
  return {
    version: 1,
    kind: "plain",
    value
  }
}

export function encryptedMemoryValue(
  value: EncryptedText,
  keyVersion: number
): MemoryValueEnvelope {
  return Schema.decodeUnknownSync(MemoryValueEnvelopeSchema)({
    version: 1,
    kind: "encrypted",
    ciphertext: value.ciphertext,
    iv: value.iv,
    keyVersion
  })
}

export function encodeMemoryValue(envelope: MemoryValueEnvelope): string {
  return JSON.stringify(Schema.encodeSync(MemoryValueEnvelopeSchema)(envelope))
}

export function decodeMemoryValue(value: string): MemoryValueEnvelope {
  return Schema.decodeUnknownSync(MemoryValueEnvelopeSchema)(JSON.parse(value))
}

export function decodeStoredMemoryValue(value: StoredMemoryValue): MemoryValueEnvelope {
  return value.envelope === ""
    ? decodeLegacyMemoryValue(value.legacy)
    : decodeMemoryValue(value.envelope)
}

export function decodeLegacyMemoryValue(value: LegacyMemoryValue): MemoryValueEnvelope {
  const hasCiphertext = value.valueCiphertext !== null
  const hasIv = value.valueIv !== null
  if (hasCiphertext !== hasIv) {
    throw new Error("Legacy memory value has incomplete encryption fields")
  }
  if (value.valueCiphertext !== null && value.valueIv !== null) {
    return encryptedMemoryValue(
      { ciphertext: value.valueCiphertext, iv: value.valueIv },
      value.keyVersion
    )
  }
  return plainMemoryValue(decodeJson(value.valueJson))
}

export async function readMemoryValue(
  envelope: MemoryValueEnvelope,
  owner: OwnerDataKey,
  protection: DataProtection
): Promise<typeof Schema.Json.Type> {
  if (envelope.kind === "plain") return envelope.value
  if (envelope.keyVersion > owner.version) {
    throw new Error("Memory value uses a newer owner data key version")
  }
  const serialized = await protection.decryptText(owner.key, {
    ciphertext: envelope.ciphertext,
    iv: envelope.iv
  })
  return decodeJson(serialized)
}
