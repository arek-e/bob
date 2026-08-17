import { ObjectStorage, type ObjectStorageError } from "@bob/object-store-types"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"

export interface ObjectStorageTestRuntime {
  readonly run: <A>(effect: Effect.Effect<A, ObjectStorageError, ObjectStorage>) => Promise<A>
  readonly dispose: () => Promise<void>
}

export function objectStorageConformance(
  name: string,
  makeRuntime: () => Promise<ObjectStorageTestRuntime>
): void {
  describe(`${name} Object Storage conformance`, () => {
    it("stores, replaces, reads, and idempotently deletes private bytes", async () => {
      const runtime = await makeRuntime()
      try {
        await expect(
          runtime.run(ObjectStorage.use((storage) => storage.get("owners/one/missing")))
        ).resolves.toBeUndefined()
        await runtime.run(
          ObjectStorage.use((storage) =>
            storage.put("owners/one/value.bin", new Uint8Array([1, 2, 3]))
          )
        )
        await runtime.run(
          ObjectStorage.use((storage) =>
            storage.put("owners/one/value.bin", new Uint8Array([4, 5]))
          )
        )
        await expect(
          runtime.run(ObjectStorage.use((storage) => storage.get("owners/one/value.bin")))
        ).resolves.toMatchObject({ body: new Uint8Array([4, 5]) })
        await runtime.run(ObjectStorage.use((storage) => storage.delete("owners/one/value.bin")))
        await runtime.run(ObjectStorage.use((storage) => storage.delete("owners/one/value.bin")))
        await expect(
          runtime.run(ObjectStorage.use((storage) => storage.get("owners/one/value.bin")))
        ).resolves.toBeUndefined()
      } finally {
        await runtime.dispose()
      }
    })

    it("returns a typed failure for an unsafe key", async () => {
      const runtime = await makeRuntime()
      try {
        await expect(
          runtime.run(ObjectStorage.use((storage) => storage.get("../escape")))
        ).rejects.toMatchObject({ _tag: "ObjectStorageError", operation: "get" })
      } finally {
        await runtime.dispose()
      }
    })
  })
}
