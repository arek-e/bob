import { describe, expect, it } from "vitest"

import {
  assertReleaseBundle,
  canonicalReleaseBundle,
  makeReleaseBundle,
  releaseBundleDigest
} from "../../../scripts/release-bundle.mjs"

const sha = "1".repeat(40)
const digest = (value: string) => `sha256:${value.repeat(64)}`

const bundle = () =>
  makeReleaseBundle({
    sourceRevision: sha,
    configurationRevision: sha,
    deploymentContractDigest: digest("a"),
    deploymentContractUri: `https://raw.githubusercontent.com/arek-e/bob/${sha}/deployment-contract.json`,
    runtimeImages: [
      { name: "backup", digest: digest("b") },
      { name: "agent", digest: digest("c") }
    ],
    agentImageDigest: digest("c"),
    backupImageDigest: digest("b")
  })

describe("Runtime release bundle", () => {
  it("has one deterministic identity", () => {
    const value = bundle()
    expect(value.runtimeImages.map((image) => image.name)).toEqual(["agent", "backup"])
    expect(releaseBundleDigest(value)).toMatch(/^sha256:[0-9a-f]{64}$/u)
    expect(canonicalReleaseBundle(value)).toBe(canonicalReleaseBundle({ ...value }))
  })

  it("binds the contract to the configuration revision", () => {
    const value = bundle()
    expect(() => assertReleaseBundle({ ...value, configurationRevision: "2".repeat(40) })).toThrow(
      "configuration revision"
    )
  })

  it("binds named image fields to the image manifest", () => {
    expect(() => assertReleaseBundle({ ...bundle(), agentImageDigest: digest("d") })).toThrow(
      "agent image"
    )
  })
})
