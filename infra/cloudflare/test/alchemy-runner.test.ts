import { readFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"

import { alchemyCommandArguments } from "../src/run-alchemy.mjs"

describe("Alchemy stage runner", () => {
  it("uses only the production Alchemy stage", async () => {
    expect(alchemyCommandArguments("plan")).toEqual(["exec", "alchemy", "plan", "--stage", "prod"])
    expect(alchemyCommandArguments("deploy")).toEqual([
      "exec",
      "alchemy",
      "deploy",
      "--stage",
      "prod",
      "--yes"
    ])
    const packageJson = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8")
    ) as { scripts: Record<string, string> }
    expect(packageJson.scripts.plan).not.toContain("$BOB_STAGE")
    expect(packageJson.scripts.deploy).not.toContain("$BOB_STAGE")
    expect(packageJson.scripts.plan).toContain("node src/run-alchemy.mjs plan")
  })

  it("rejects unsupported commands", () => {
    expect(() => alchemyCommandArguments("destroy")).toThrow(/command/u)
  })
})
