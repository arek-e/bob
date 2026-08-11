import { Decrypter, Encrypter } from "age-encryption"
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

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson)
  if (typeof value !== "object" || value === null) return value
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortJson(item)])
  )
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value))
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
    objects: archive.objects.map(({ key, etag, contentType, bytesBase64, sha256: hash }) => ({
      key,
      ...(etag === undefined ? {} : { etag }),
      ...(contentType === undefined ? {} : { contentType }),
      byteLength: Buffer.from(bytesBase64, "base64").byteLength,
      sha256: hash
    }))
  })
}

export function createArchive(
  input: Omit<BackupArchive, "schemaVersion" | "manifestSha256">
): BackupArchive {
  const withoutHash = { schemaVersion: 1 as const, ...input }
  return { ...withoutHash, manifestSha256: sha256(archiveManifest(withoutHash)) }
}

export function validateArchive(value: unknown): BackupArchive {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Backup archive is not an object")
  }
  const archive = value as Partial<BackupArchive>
  if (
    archive.schemaVersion !== 1 ||
    typeof archive.createdAt !== "string" ||
    typeof archive.cutoffStartedAt !== "string" ||
    typeof archive.cutoffFinishedAt !== "string" ||
    typeof archive.source !== "object" ||
    archive.source === null ||
    !Array.isArray(archive.tables) ||
    !Array.isArray(archive.objects) ||
    typeof archive.manifestSha256 !== "string"
  ) {
    throw new Error("Backup archive shape is invalid")
  }
  const candidate = archive as BackupArchive
  for (const table of candidate.tables) {
    if (
      typeof table.name !== "string" ||
      !Array.isArray(table.rows) ||
      table.sha256 !== tableHash(table.rows)
    ) {
      throw new Error("Backup table integrity check failed")
    }
  }
  for (const object of candidate.objects) {
    if (
      typeof object.key !== "string" ||
      typeof object.bytesBase64 !== "string" ||
      object.sha256 !== sha256(Buffer.from(object.bytesBase64, "base64"))
    ) {
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
  const decoded = JSON.parse(gunzipSync(compressed).toString("utf8")) as unknown
  return validateArchive(decoded)
}
