import { ObjectStorage, ObjectStorageError, validatedObjectKey } from "@bob/object-store-types"
import { Effect, Layer } from "effect"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, resolve, sep } from "node:path"

function objectPath(root: string, key: string): string {
  const target = resolve(root, validatedObjectKey(key))
  if (!target.startsWith(`${root}${sep}`)) throw new TypeError("Object key escapes root")
  return target
}

export function filesystemObjectStorageLayer(root: string) {
  const normalizedRoot = resolve(root)
  return Layer.succeed(
    ObjectStorage,
    ObjectStorage.of({
      get: Effect.fnUntraced(function* (key: string) {
        return yield* Effect.tryPromise({
          try: async () => {
            try {
              return { body: new Uint8Array(await readFile(objectPath(normalizedRoot, key))) }
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
              throw error
            }
          },
          catch: (cause) => new ObjectStorageError({ operation: "get", cause })
        })
      }),
      put: Effect.fnUntraced(function* (key: string, body: Uint8Array) {
        yield* Effect.tryPromise({
          try: async () => {
            const target = objectPath(normalizedRoot, key)
            const temporary = `${target}.${crypto.randomUUID()}.tmp`
            await mkdir(dirname(target), { recursive: true })
            try {
              await writeFile(temporary, body, { mode: 0o600 })
              await rename(temporary, target)
            } catch (error) {
              await rm(temporary, { force: true }).catch(() => undefined)
              throw error
            }
          },
          catch: (cause) => new ObjectStorageError({ operation: "put", cause })
        })
      }),
      delete: Effect.fnUntraced(function* (key: string) {
        yield* Effect.tryPromise({
          try: () => rm(objectPath(normalizedRoot, key), { force: true }),
          catch: (cause) => new ObjectStorageError({ operation: "delete", cause })
        })
      })
    })
  )
}
