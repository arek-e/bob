import { Decrypter, Encrypter } from "age-encryption"
import { Schema } from "effect"
import { createHash } from "node:crypto"
import { gunzipSync, gzipSync } from "node:zlib"

export type BackupScalar = string | number | boolean | null
export type BackupRow = Readonly<Record<string, BackupScalar | readonly number[]>>

export interface BackupTable {
  readonly name: string
  readonly rows: readonly BackupRow[]
  readonly sha256: string
}

export interface BackupObject {
  readonly key: string
  readonly etag?: string
  readonly contentType?: string
  readonly bytesBase64: string
  readonly sha256: string
}

export interface BackupArchive {
  readonly schemaVersion: 1
  readonly createdAt: string
  readonly cutoffStartedAt: string
  readonly cutoffFinishedAt: string
  readonly source: {
    readonly accountId: string
    readonly databaseId: string
    readonly bucket: string
  }
  readonly tables: readonly BackupTable[]
  readonly objects: readonly BackupObject[]
  readonly manifestSha256: string
}

const BackupScalarValue = Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Null])
const BackupByte = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 }))
export const BackupRowValue = Schema.Record(
  Schema.String,
  Schema.Union([BackupScalarValue, Schema.Array(BackupByte)])
)
const BackupTableValue = Schema.Struct({
  name: Schema.String,
  rows: Schema.Array(BackupRowValue),
  sha256: Schema.String
})
const BackupObjectValue = Schema.Struct({
  key: Schema.String,
  etag: Schema.optionalKey(Schema.String),
  contentType: Schema.optionalKey(Schema.String),
  bytesBase64: Schema.String,
  sha256: Schema.String
})
const BackupArchiveValue = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  createdAt: Schema.String,
  cutoffStartedAt: Schema.String,
  cutoffFinishedAt: Schema.String,
  source: Schema.Struct({
    accountId: Schema.String,
    databaseId: Schema.String,
    bucket: Schema.String
  }),
  tables: Schema.Array(BackupTableValue),
  objects: Schema.Array(BackupObjectValue),
  manifestSha256: Schema.String
})

function isJsonObject(
  value: typeof Schema.Json.Type
): value is { readonly [key: string]: typeof Schema.Json.Type } {
  return value !== null && !Array.isArray(value) && Object(value) === value
}

function sortJson(value: typeof Schema.Json.Type): typeof Schema.Json.Type {
  if (Array.isArray(value)) return value.map(sortJson)
  if (!isJsonObject(value)) return value
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortJson(item)])
  )
}

export function canonicalJson<Input>(value: Input): string {
  return JSON.stringify(sortJson(Schema.decodeUnknownSync(Schema.Json)(value)))
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}

export function tableHash(rows: readonly BackupRow[]): string {
  return sha256(rows.map((row) => canonicalJson(row)).join("\n"))
}

function archiveManifest(archive: Omit<BackupArchive, "manifestSha256">): string {
  return canonicalJson({
    schemaVersion: archive.schemaVersion,
    createdAt: archive.createdAt,
    cutoffStartedAt: archive.cutoffStartedAt,
    cutoffFinishedAt: archive.cutoffFinishedAt,
    source: archive.source,
    tables: archive.tables.map(({ name, rows, sha256: hash }) => ({
      name,
      rowCount: rows.length,
      sha256: hash
    })),
    objects: archive.objects.map(({ key, etag, contentType, bytesBase64, sha256: hash }) => {
      const base = {
        key,
        byteLength: Buffer.from(bytesBase64, "base64").byteLength,
        sha256: hash
      }
      if (etag === undefined && contentType === undefined) return base
      if (etag === undefined && contentType !== undefined) return { ...base, contentType }
      if (etag !== undefined && contentType === undefined) return { ...base, etag }
      if (etag === undefined || contentType === undefined) return base
      return { ...base, etag, contentType }
    })
  })
}

export function createArchive(
  input: Omit<BackupArchive, "schemaVersion" | "manifestSha256">
): BackupArchive {
  const withoutHash = { schemaVersion: 1 as const, ...input }
  return { ...withoutHash, manifestSha256: sha256(archiveManifest(withoutHash)) }
}

export function validateArchive<Input>(value: Input): BackupArchive {
  const candidate = Schema.decodeUnknownSync(BackupArchiveValue)(value)
  for (const table of candidate.tables) {
    if (table.sha256 !== tableHash(table.rows)) {
      throw new Error("Backup table integrity check failed")
    }
  }
  for (const object of candidate.objects) {
    if (object.sha256 !== sha256(Buffer.from(object.bytesBase64, "base64"))) {
      throw new Error("Backup object integrity check failed")
    }
  }
  const { manifestSha256, ...withoutHash } = candidate
  if (manifestSha256 !== sha256(archiveManifest(withoutHash))) {
    throw new Error("Backup manifest integrity check failed")
  }
  return candidate
}

export async function encryptArchive(
  archive: BackupArchive,
  recipient: string,
  maxBytes: number
): Promise<Uint8Array> {
  const compressed = gzipSync(canonicalJson(archive), { level: 9 })
  if (compressed.byteLength > maxBytes) throw new Error("Backup exceeds its encrypted size budget")
  const encrypter = new Encrypter()
  encrypter.addRecipient(recipient)
  return encrypter.encrypt(compressed)
}

export async function decryptArchive(
  ciphertext: Uint8Array,
  identity: string
): Promise<BackupArchive> {
  const decrypter = new Decrypter()
  decrypter.addIdentity(identity.trim())
  const compressed = await decrypter.decrypt(ciphertext)
  const decoded = JSON.parse(gunzipSync(compressed).toString("utf8"))
  return validateArchive(decoded)
}
