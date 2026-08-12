import { AwsClient } from "aws4fetch"
import { randomUUID } from "node:crypto"
import { mkdir, open, rename, unlink } from "node:fs/promises"
import { join } from "node:path"

export interface WriteEncryptedBackupOptions {
  readonly outputDirectory: string
  readonly filename: string
  readonly ciphertext: Uint8Array
  readonly randomUuid?: () => string
}

export interface UploadEncryptedBackupOptions {
  readonly endpoint: string
  readonly region: string
  readonly bucket: string
  readonly prefix: string
  readonly filename: string
  readonly ciphertext: Uint8Array
  readonly accessKeyId: string
  readonly secretAccessKey: string
}

function directorySyncIsUnsupported(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false
  return ["EBADF", "EINVAL", "EISDIR", "ENOSYS", "ENOTSUP", "EPERM"].includes(String(error.code))
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined
  return String(error.code)
}

async function syncDirectory(directory: string): Promise<void> {
  let handle
  try {
    handle = await open(directory, "r")
    await handle.sync()
  } catch (error) {
    if (!directorySyncIsUnsupported(error)) throw error
  } finally {
    await handle?.close()
  }
}

export async function writeEncryptedBackup(options: WriteEncryptedBackupOptions): Promise<string> {
  await mkdir(options.outputDirectory, { recursive: true })
  const finalPath = join(options.outputDirectory, options.filename)
  const uuid = (options.randomUuid ?? randomUUID)()
  const temporaryPath = join(options.outputDirectory, `.${options.filename}.${uuid}.tmp`)
  let ownsTemporaryPath = false
  try {
    const handle = await open(temporaryPath, "wx", 0o600)
    ownsTemporaryPath = true
    try {
      await handle.writeFile(options.ciphertext)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporaryPath, finalPath)
    ownsTemporaryPath = false
    await syncDirectory(options.outputDirectory)
    return finalPath
  } catch (error) {
    if (ownsTemporaryPath) {
      try {
        await unlink(temporaryPath)
      } catch (cleanupError) {
        if (errorCode(cleanupError) !== "ENOENT") {
          throw new AggregateError(
            [error, cleanupError],
            "Backup file publication and cleanup failed"
          )
        }
      }
    }
    throw error
  }
}

export async function uploadEncryptedBackup(options: UploadEncryptedBackupOptions): Promise<void> {
  const endpoint = new URL(options.endpoint)
  if (!endpoint.pathname.endsWith("/")) endpoint.pathname += "/"
  const prefix = options.prefix
    .split("/")
    .filter((part) => part.length > 0)
    .map(encodeURIComponent)
    .join("/")
  const key = [prefix, encodeURIComponent(options.filename)]
    .filter((part) => part.length > 0)
    .join("/")
  const target = new URL(`${encodeURIComponent(options.bucket)}/${key}`, endpoint)
  const client = new AwsClient({
    accessKeyId: options.accessKeyId,
    secretAccessKey: options.secretAccessKey,
    service: "s3",
    region: options.region,
    retries: 3
  })
  const body = new ArrayBuffer(options.ciphertext.byteLength)
  new Uint8Array(body).set(options.ciphertext)
  const response = await client.fetch(target, {
    method: "PUT",
    headers: { "content-type": "application/octet-stream" },
    body
  })
  if (!response.ok) throw new Error(`Independent backup upload failed: ${response.status}`)
}
