import { describe, expect, it, vi } from "vitest"

import {
  CoolifyReleaseClient,
  releaseEnvironment,
  releaseToCoolify
} from "../../../scripts/coolify-release.mjs"

const digest = (character: string) => `sha256:${character.repeat(64)}`

const bundle = {
  sourceRevision: "a".repeat(40),
  agentImageDigest: digest("1"),
  backupImageDigest: digest("2"),
  runtimeImages: [
    { name: "cloudflared", digest: digest("3") },
    { name: "observer", digest: digest("4") }
  ]
}

describe("Coolify release", () => {
  it("maps one immutable bundle to the reviewed Runtime variables", () => {
    expect(releaseEnvironment(bundle)).toEqual({
      BOB_RELEASE_SHA: "a".repeat(40),
      BOB_AGENT_IMAGE_DIGEST: digest("1"),
      BOB_BACKUP_IMAGE_DIGEST: digest("2"),
      CLOUDFLARED_IMAGE_DIGEST: digest("3"),
      BOB_OBSERVER_IMAGE_DIGEST: digest("4")
    })
  })

  it("rejects an incomplete release bundle", () => {
    expect(() => releaseEnvironment({ ...bundle, runtimeImages: [] })).toThrow(
      "CLOUDFLARED_IMAGE_DIGEST"
    )
  })

  it("requires one production value and ignores preview values", async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(
      Response.json([
        { key: "BOB_RELEASE_SHA", value: "a".repeat(40), is_preview: false },
        { key: "BOB_RELEASE_SHA", value: "preview", is_preview: true }
      ])
    )
    const client = new CoolifyReleaseClient({
      baseUrl: "https://coolify.example.test",
      token: "token",
      applicationId: "runtime",
      fetchImplementation
    })
    await expect(client.currentEnvironment(["BOB_RELEASE_SHA"])).resolves.toEqual({
      BOB_RELEASE_SHA: "a".repeat(40)
    })
  })

  it("restores the prior pins and deploys them after a failed release", async () => {
    const previous = {
      BOB_RELEASE_SHA: "b".repeat(40),
      BOB_AGENT_IMAGE_DIGEST: digest("5"),
      BOB_BACKUP_IMAGE_DIGEST: digest("6"),
      CLOUDFLARED_IMAGE_DIGEST: digest("7"),
      BOB_OBSERVER_IMAGE_DIGEST: digest("8")
    }
    const client = {
      currentEnvironment: vi.fn().mockResolvedValue(previous),
      updateEnvironment: vi.fn().mockResolvedValue(undefined),
      deploy: vi.fn().mockResolvedValueOnce("release").mockResolvedValueOnce("rollback"),
      waitForDeployment: vi
        .fn()
        .mockRejectedValueOnce(new Error("failed"))
        .mockResolvedValueOnce(undefined)
    }
    await expect(releaseToCoolify({ client, bundle })).rejects.toThrow("failed")
    expect(client.updateEnvironment).toHaveBeenNthCalledWith(2, previous)
    expect(client.waitForDeployment).toHaveBeenNthCalledWith(
      2,
      "rollback",
      previous.BOB_RELEASE_SHA,
      undefined
    )
  })
})
