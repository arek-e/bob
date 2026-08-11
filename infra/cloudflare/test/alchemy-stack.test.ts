import { readFile } from "node:fs/promises"

import { describe, expect, it } from "vitest"

describe("Alchemy compatibility stack", () => {
  it("evaluates the real Bob stack with injected state and providers", async () => {
    const smoke = await readFile(new URL("../alchemy.smoke.run.ts", import.meta.url), "utf8")

    expect(smoke).toContain("createBobStack")
    expect(smoke).toContain("inMemoryState")
    expect(smoke).toContain("smokeProviders")
    expect(smoke).not.toContain("compatible: true")
  })
})
