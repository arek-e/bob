import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

import { makeR2PrivateObjectStore } from "../src/cloudflare.ts"
import { makeFilesystemPrivateObjectStore } from "../src/filesystem.ts"
import { validatedObjectKey } from "../src/index.ts"

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })))
})

describe("PrivateObjectStore", () => {
  it("stores, reads, and deletes bytes on the filesystem", async () => {
    const root = await mkdtemp(join(tmpdir(), "bob-object-store-"))
    temporaryRoots.push(root)
    const store = makeFilesystemPrivateObjectStore(root)

    await store.put("owners/one/value.bin", new Uint8Array([1, 2, 3]))
    await expect(store.get("owners/one/value.bin")).resolves.toEqual({
      body: new Uint8Array([1, 2, 3])
    })
    await store.delete("owners/one/value.bin")
    await expect(store.get("owners/one/value.bin")).resolves.toBeUndefined()
  })

  it("maps the same Interface to R2", async () => {
    const put = vi.fn(async () => ({}))
    const remove = vi.fn(async () => undefined)
    const store = makeR2PrivateObjectStore({
      get: vi.fn(async () => ({
        etag: "etag",
        httpMetadata: { contentType: "application/octet-stream" },
        arrayBuffer: async () => new Uint8Array([4, 5]).buffer
      })),
      put,
      delete: remove
    })

    await expect(store.get("safe/key")).resolves.toEqual({
      body: new Uint8Array([4, 5]),
      etag: "etag",
      contentType: "application/octet-stream"
    })
    await store.put("safe/key", new Uint8Array([6]), { contentType: "text/plain" })
    await store.delete("safe/key")
    expect(put).toHaveBeenCalledOnce()
    expect(remove).toHaveBeenCalledWith("safe/key")
  })

  it.each(["", "/root", "root/", "a//b", "../escape", "a/../b", "a\\b"])(
    "rejects unsafe key %s",
    (key) => expect(() => validatedObjectKey(key)).toThrow("Private object key is invalid")
  )
})
