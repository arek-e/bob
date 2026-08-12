import { readFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"

import { assertReleaseGitOpsDelta } from "../../../scripts/verify-release-gitops-delta.mjs"

const repositoryRoot = new URL("../../../", import.meta.url)
const sourceSha = "1111111111111111111111111111111111111111"
const agentDigest = `sha256:${"a".repeat(64)}`
const backupDigest = `sha256:${"b".repeat(64)}`

function replaceReleaseValue(overlay: string, marker: string, value: string): string {
  const lines = overlay.split("\n")
  const markerIndex = lines.findIndex((line) => line.trim() === marker)
  if (markerIndex === -1 || lines[markerIndex + 1] === undefined) {
    throw new Error(`Missing test marker: ${marker}`)
  }
  lines[markerIndex + 1] = lines[markerIndex + 1].replace(/\S+$/u, value)
  return lines.join("\n")
}

function reviewedDelta(sourceOverlay: string): string {
  return [
    ["newName: ghcr.io/arek-e/bob-agent", agentDigest],
    ["newName: ghcr.io/arek-e/bob-data-backup", backupDigest],
    ["path: /data/BOB_RELEASE_SHA", sourceSha]
  ].reduce((overlay, [marker, value]) => replaceReleaseValue(overlay, marker, value), sourceOverlay)
}

describe("release GitOps delta", () => {
  it("accepts only two new image digests and the exact source SHA", async () => {
    const sourceOverlay = await readFile(
      new URL("infra/kubernetes/overlays/prod/kustomization.yaml", repositoryRoot),
      "utf8"
    )

    expect(
      assertReleaseGitOpsDelta({
        sourceOverlay,
        gitopsOverlay: reviewedDelta(sourceOverlay),
        sourceSha
      })
    ).toEqual({ agentDigest, backupDigest, releaseSha: sourceSha })
  })

  it("rejects another image or patch change", async () => {
    const sourceOverlay = await readFile(
      new URL("infra/kubernetes/overlays/prod/kustomization.yaml", repositoryRoot),
      "utf8"
    )
    const reviewed = reviewedDelta(sourceOverlay)

    expect(() =>
      assertReleaseGitOpsDelta({
        sourceOverlay,
        gitopsOverlay: reviewed.replace(
          "value: http://openbao.openbao.svc.cluster.local:8200",
          "value: https://unreviewed.invalid"
        ),
        sourceSha
      })
    ).toThrow(/outside the three release values/u)
    expect(() =>
      assertReleaseGitOpsDelta({
        sourceOverlay,
        gitopsOverlay: reviewed.replace(
          /newName: docker\.io\/nangohq\/nango-server\n    digest: sha256:[a-f0-9]{64}/u,
          `newName: docker.io/nangohq/nango-server\n    digest: sha256:${"c".repeat(64)}`
        ),
        sourceSha
      })
    ).toThrow(/outside the three release values/u)
  })

  it("rejects an unchanged pin or a different release SHA", async () => {
    const sourceOverlay = await readFile(
      new URL("infra/kubernetes/overlays/prod/kustomization.yaml", repositoryRoot),
      "utf8"
    )
    const reviewed = reviewedDelta(sourceOverlay)
    const sourceAgentDigest = sourceOverlay.match(
      /newName: ghcr\.io\/arek-e\/bob-agent\n    digest: (sha256:[a-f0-9]{64})/u
    )?.[1]
    if (sourceAgentDigest === undefined) throw new Error("Missing source agent digest")

    expect(() =>
      assertReleaseGitOpsDelta({
        sourceOverlay,
        gitopsOverlay: reviewed.replace(agentDigest, sourceAgentDigest),
        sourceSha
      })
    ).toThrow(/must change the agent digest/u)
    expect(() =>
      assertReleaseGitOpsDelta({
        sourceOverlay,
        gitopsOverlay: reviewed.replace(sourceSha, "2222222222222222222222222222222222222222"),
        sourceSha
      })
    ).toThrow(/must equal the source SHA/u)
  })
})
