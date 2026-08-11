import { readFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"

describe("data backup platform contract", () => {
  it("does not regenerate TypeScript files during read-only startup", async () => {
    const schema = await readFile(new URL("../.env.schema", import.meta.url), "utf8")

    expect(schema).toContain(
      "@generateTsTypes(path=./src/environment.generated.ts, exposeEnv=local, auto=false)"
    )
  })
})
