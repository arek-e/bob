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
      { name: "agent", digest: digest("c") },
      { name: "observer", digest: digest("d") },
      { name: "cloudflared", digest: digest("e") }
    ]
  })

describe("Runtime release bundle", () => {
  it("has one deterministic identity", () => {
    const value = bundle()
    expect(value.schemaVersion).toBe("bob.release.v2")
    expect(value.runtimeImages.map((image) => image.name)).toEqual([
      "agent",
      "backup",
      "cloudflared",
      "observer"
    ])
    expect(value).not.toHaveProperty("agentImageDigest")
    expect(value).not.toHaveProperty("backupImageDigest")
    expect(releaseBundleDigest(value)).toMatch(/^sha256:[0-9a-f]{64}$/u)
    expect(canonicalReleaseBundle(value)).toBe(canonicalReleaseBundle({ ...value }))
  })

  it("binds the contract to the configuration revision", () => {
    const value = bundle()
    expect(() => assertReleaseBundle({ ...value, configurationRevision: "2".repeat(40) })).toThrow(
      "configuration revision"
    )
  })

  it("decodes an immutable two-image v1 bundle", () => {
    const value = bundle()
    const legacyBundle = {
      ...value,
      schemaVersion: "bob.release.v1",
      runtimeImages: value.runtimeImages.filter((image) =>
        ["agent", "backup"].includes(image.name)
      ),
      agentImageDigest: digest("c"),
      backupImageDigest: digest("b")
    }
    const decoded = assertReleaseBundle(legacyBundle)

    expect(decoded).toEqual({
      ...legacyBundle,
      runtimeImages: [
        { name: "agent", digest: digest("c") },
        { name: "backup", digest: digest("b") }
      ]
    })
  })

  it("rejects conflicting v1 image aliases", () => {
    const value = bundle()
    expect(() =>
      assertReleaseBundle({
        ...value,
        schemaVersion: "bob.release.v1",
        agentImageDigest: digest("f"),
        backupImageDigest: digest("b")
      })
    ).toThrow("agent image")
  })

  it("requires unique named Runtime images", () => {
    const value = bundle()
    expect(() =>
      assertReleaseBundle({
        ...value,
        runtimeImages: [...value.runtimeImages, { name: "agent", digest: digest("f") }]
      })
    ).toThrow("image manifest")
  })

  it("requires every reviewed Runtime image", () => {
    const value = bundle()
    expect(() =>
      assertReleaseBundle({
        ...value,
        runtimeImages: value.runtimeImages.filter((image) => image.name !== "observer")
      })
    ).toThrow("observer image")
  })

  it("does not apply v2 required-image rules to v1 bundles", () => {
    const value = bundle()
    expect(() =>
      assertReleaseBundle({
        ...value,
        schemaVersion: "bob.release.v1",
        runtimeImages: value.runtimeImages.filter((image) =>
          ["agent", "backup"].includes(image.name)
        ),
        agentImageDigest: digest("c"),
        backupImageDigest: digest("b")
      })
    ).not.toThrow()
  })

  it("rejects invalid image digests", () => {
    const value = bundle()
    expect(() =>
      assertReleaseBundle({
        ...value,
        runtimeImages: value.runtimeImages.map((image) =>
          image.name === "agent" ? { ...image, digest: "latest" } : image
        )
      })
    ).toThrow("image manifest")
  })
})
