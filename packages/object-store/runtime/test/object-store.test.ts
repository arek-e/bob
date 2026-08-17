import { ManagedRuntime } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { filesystemObjectStorageLayer } from "../src/filesystem.ts"
import { objectStorageConformance } from "./conformance.ts"

objectStorageConformance("filesystem", async () => {
  const root = await mkdtemp(join(tmpdir(), "bob-object-store-"))
  const runtime = ManagedRuntime.make(filesystemObjectStorageLayer(root))
  return {
    run: (effect) => runtime.runPromise(effect),
    async dispose() {
      await runtime.dispose()
      await rm(root, { recursive: true })
    }
  }
})
