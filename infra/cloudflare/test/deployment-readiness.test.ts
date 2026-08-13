import { readFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"

import { assertCoolifyComposeReadiness } from "../../../scripts/validate-coolify-compose.mjs"

describe("Coolify deployment readiness", () => {
  it("accepts the public Compose contract", async () => {
    const compose = await readFile("infra/coolify/compose.yaml", "utf8")
    expect(assertCoolifyComposeReadiness(compose)).toEqual({ services: 5 })
  })

  it("rejects mutable images and host ports", async () => {
    const compose = await readFile("infra/coolify/compose.yaml", "utf8")
    expect(() =>
      assertCoolifyComposeReadiness(compose.replace(/@\$\{[^}]+\}/u, ":latest"))
    ).toThrow(/latest|immutable image digest/u)
    expect(() => assertCoolifyComposeReadiness(`${compose}\n  ports:\n    - "8787:8787"`)).toThrow(
      /host ports/u
    )
  })

  it("rejects private legacy topology", async () => {
    const compose = await readFile("infra/coolify/compose.yaml", "utf8")
    expect(() => assertCoolifyComposeReadiness(`${compose}\n# cluster.local`)).toThrow(
      /private legacy/u
    )
  })
})
