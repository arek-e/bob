import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, resolve, sep } from "node:path"

import type { PrivateObjectStore } from "./index.ts"

import { validatedObjectKey } from "./index.ts"

function objectPath(root: string, key: string): string {
  const normalizedRoot = resolve(root)
  const target = resolve(normalizedRoot, validatedObjectKey(key))
  if (!target.startsWith(`${normalizedRoot}${sep}`)) throw new TypeError("Object key escapes root")
  return target
}

export function makeFilesystemPrivateObjectStore(root: string): PrivateObjectStore {
  const normalizedRoot = resolve(root)
  return {
    async get(key) {
      try {
        return { body: new Uint8Array(await readFile(objectPath(normalizedRoot, key))) }
      } catch (error) {
        // SAFETY: Node filesystem failures use ErrnoException and expose the stable code field.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
        throw error
      }
    },
    async put(key, body) {
      const target = objectPath(normalizedRoot, key)
      const temporary = `${target}.${crypto.randomUUID()}.tmp`
      await mkdir(dirname(target), { recursive: true })
      await writeFile(temporary, body, { mode: 0o600 })
      await rename(temporary, target)
    },
    async delete(key) {
      await rm(objectPath(normalizedRoot, key), { force: true })
    }
  }
}
