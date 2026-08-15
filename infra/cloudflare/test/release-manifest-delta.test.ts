import { readFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"

import { assertReleaseManifestDelta } from "../../../scripts/verify-release-manifest-delta.mjs"

const repositoryRoot = new URL("../../../", import.meta.url)
const sourceSha = "1111111111111111111111111111111111111111"
const agentDigest = `sha256:${"a".repeat(64)}`
const backupDigest = `sha256:${"b".repeat(64)}`

async function sourceManifest() {
  return readFile(new URL("infra/coolify/release.json", repositoryRoot), "utf8")
}

function deploymentManifest(source: string) {
  return JSON.stringify({
    ...JSON.parse(source),
    sourceSha,
    agentDigest,
    backupDigest
  })
}

describe("Coolify release manifest delta", () => {
  it("accepts only two image digests and the exact source SHA", async () => {
    const source = await sourceManifest()
    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    const current = JSON.parse(source) as {
      cloudflaredDigest: string
      observerDigest: string
    }
    expect(
      assertReleaseManifestDelta({
        sourceManifest: source,
        deploymentManifest: deploymentManifest(source),
        sourceSha
      })
    ).toEqual({
      agentDigest,
      backupDigest,
      cloudflaredDigest: current.cloudflaredDigest,
      observerDigest: current.observerDigest,
      releaseSha: sourceSha
    })
  })

  it("rejects another runtime change", async () => {
    const source = await sourceManifest()
    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    const deployment = JSON.parse(deploymentManifest(source)) as {
      unreviewed?: boolean
    }
    deployment.unreviewed = true
    expect(() =>
      assertReleaseManifestDelta({
        sourceManifest: source,
        deploymentManifest: JSON.stringify(deployment),
        sourceSha
      })
    ).toThrow(/outside the three release values/u)
  })

  it("rejects an unchanged pin or a different source SHA", async () => {
    const source = await sourceManifest()
    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    const current = JSON.parse(source) as { agentDigest: string }
    expect(() =>
      assertReleaseManifestDelta({
        sourceManifest: source,
        deploymentManifest: deploymentManifest(source).replace(agentDigest, current.agentDigest),
        sourceSha
      })
    ).toThrow(/change the agent digest/u)
    expect(() =>
      assertReleaseManifestDelta({
        sourceManifest: source,
        deploymentManifest: deploymentManifest(source).replace(
          sourceSha,
          "2222222222222222222222222222222222222222"
        ),
        sourceSha
      })
    ).toThrow(/equal the reviewed source SHA/u)
  })
})
