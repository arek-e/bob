import { randomUUID } from "node:crypto"
import { mkdir, open, rename, unlink } from "node:fs/promises"
import { join } from "node:path"

export interface WriteEncryptedBackupOptions {
  readonly outputDirectory: string
  readonly filename: string
  readonly ciphertext: Uint8Array
  readonly randomUuid?: () => string
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
