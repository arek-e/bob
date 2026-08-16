import { describe, expect, it, vi } from "vitest"

import {
  CoolifyReleaseClient,
  createAgentReadinessVerifier,
  releaseEnvironment,
  releaseToCoolify
} from "../../../scripts/coolify-release.mjs"

const digest = (character: string) => `sha256:${character.repeat(64)}`

const bundle = {
  schemaVersion: "bob.release.v2",
  sourceRevision: "a".repeat(40),
  configurationRevision: "a".repeat(40),
  deploymentContractDigest: digest("9"),
  deploymentContractUri: `https://raw.githubusercontent.com/arek-e/bob/${"a".repeat(40)}/deployment-contract.json`,
  runtimeImages: [
    { name: "agent", digest: digest("1") },
    { name: "backup", digest: digest("2") },
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
    expect(() => releaseEnvironment({ ...bundle, runtimeImages: [] })).toThrow("image manifest")
  })

  it("maps a compatible v1 bundle through the Runtime image manifest", () => {
    expect(
      releaseEnvironment({
        ...bundle,
        schemaVersion: "bob.release.v1",
        agentImageDigest: digest("1"),
        backupImageDigest: digest("2")
      })
    ).toEqual({
      BOB_RELEASE_SHA: "a".repeat(40),
      BOB_AGENT_IMAGE_DIGEST: digest("1"),
      BOB_BACKUP_IMAGE_DIGEST: digest("2"),
      CLOUDFLARED_IMAGE_DIGEST: digest("3"),
      BOB_OBSERVER_IMAGE_DIGEST: digest("4")
    })
  })

  it("rejects a valid legacy bundle when Coolify needs an omitted image", () => {
    expect(() =>
      releaseEnvironment({
        ...bundle,
        schemaVersion: "bob.release.v1",
        runtimeImages: bundle.runtimeImages.filter((image) =>
          ["agent", "backup"].includes(image.name)
        ),
        agentImageDigest: digest("1"),
        backupImageDigest: digest("2")
      })
    ).toThrow("Coolify promotion needs the cloudflared Runtime image")
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

  it("updates the exact Coolify source revision", async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(Response.json({ message: "updated" }))
    const client = new CoolifyReleaseClient({
      baseUrl: "https://coolify.example.test",
      token: "token",
      applicationId: "runtime",
      fetchImplementation
    })

    await client.updateSourceRevision("c".repeat(40))

    expect(fetchImplementation).toHaveBeenCalledWith(
      new URL("https://coolify.example.test/api/v1/applications/runtime"),
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ git_commit_sha: "c".repeat(40) })
      })
    )
  })

  it("stops deployment polling when its phase deadline has passed", async () => {
    const fetchImplementation = vi.fn()
    const client = new CoolifyReleaseClient({
      baseUrl: "https://coolify.example.test",
      token: "token",
      applicationId: "runtime",
      fetchImplementation,
      nowImplementation: () => 101
    })

    await expect(
      client.waitForDeployment("deployment", "c".repeat(40), {
        attempts: 1,
        intervalMs: 0,
        deadline: 100
      })
    ).rejects.toThrow("Coolify release phase exceeded its deadline")
    expect(fetchImplementation).not.toHaveBeenCalled()
  })

  it("retries Agent readiness within a bounded attempt count", async () => {
    const fetchImplementation = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ ready: false }))
      .mockResolvedValueOnce(
        Response.json({
          ready: true,
          checks: { credentials: "ready", core: "ready" },
          deploymentProfileId: "core"
        })
      )
    const verifyReadiness = createAgentReadinessVerifier({
      originUrl: "https://agent.example.test",
      clientId: "client-id",
      clientSecret: "client-secret",
      fetchImplementation,
      options: { attempts: 2, intervalMs: 0 }
    })

    await expect(verifyReadiness()).resolves.toBeUndefined()
    expect(fetchImplementation).toHaveBeenCalledTimes(2)
    expect(fetchImplementation).toHaveBeenLastCalledWith(
      new URL("https://agent.example.test/v1/admin/readiness"),
      expect.objectContaining({
        headers: {
          authorization: "Bearer client-secret",
          "cf-access-client-id": "client-id",
          "cf-access-client-secret": "client-secret"
        }
      })
    )
  })

  it("fails readiness after its bounded attempt count", async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(Response.json({ ready: false }))
    const verifyReadiness = createAgentReadinessVerifier({
      originUrl: "https://agent.example.test",
      clientId: "client-id",
      clientSecret: "client-secret",
      fetchImplementation,
      options: { attempts: 2, intervalMs: 0 }
    })

    await expect(verifyReadiness()).rejects.toThrow(
      "Agent readiness did not pass before its deadline"
    )
    expect(fetchImplementation).toHaveBeenCalledTimes(2)
  })

  it("returns success only after the released Runtime becomes ready", async () => {
    const previous = {
      BOB_RELEASE_SHA: "b".repeat(40),
      BOB_AGENT_IMAGE_DIGEST: digest("5"),
      BOB_BACKUP_IMAGE_DIGEST: digest("6"),
      CLOUDFLARED_IMAGE_DIGEST: digest("7"),
      BOB_OBSERVER_IMAGE_DIGEST: digest("8")
    }
    const client = {
      currentEnvironment: vi.fn().mockResolvedValue(previous),
      updateSourceRevision: vi.fn().mockResolvedValue(undefined),
      updateEnvironment: vi.fn().mockResolvedValue(undefined),
      deploy: vi.fn().mockResolvedValue("release"),
      waitForDeployment: vi.fn().mockResolvedValue(undefined)
    }
    const verifyReadiness = vi.fn().mockResolvedValue(undefined)

    await expect(releaseToCoolify({ client, bundle, verifyReadiness })).resolves.toEqual({
      deploymentId: "release",
      sourceRevision: bundle.sourceRevision
    })
    expect(verifyReadiness).toHaveBeenCalledWith(
      expect.objectContaining({
        deploymentId: "release",
        sourceRevision: bundle.sourceRevision,
        phase: "release"
      })
    )
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
      updateSourceRevision: vi.fn().mockResolvedValue(undefined),
      updateEnvironment: vi.fn().mockResolvedValue(undefined),
      deploy: vi.fn().mockResolvedValueOnce("release").mockResolvedValueOnce("rollback"),
      waitForDeployment: vi
        .fn()
        .mockRejectedValueOnce(new Error("failed"))
        .mockResolvedValueOnce(undefined)
    }
    const verifyReadiness = vi.fn().mockResolvedValue(undefined)
    await expect(releaseToCoolify({ client, bundle, verifyReadiness })).rejects.toThrow("failed")
    expect(client.updateSourceRevision).toHaveBeenNthCalledWith(
      1,
      bundle.sourceRevision,
      expect.objectContaining({ deadline: expect.any(Number) })
    )
    expect(client.updateSourceRevision).toHaveBeenNthCalledWith(
      2,
      "b".repeat(40),
      expect.objectContaining({ deadline: expect.any(Number) })
    )
    expect(client.updateEnvironment).toHaveBeenNthCalledWith(
      2,
      previous,
      expect.objectContaining({ deadline: expect.any(Number) })
    )
    expect(client.waitForDeployment).toHaveBeenNthCalledWith(
      2,
      "rollback",
      previous.BOB_RELEASE_SHA,
      expect.objectContaining({ deadline: expect.any(Number) })
    )
    expect(verifyReadiness).toHaveBeenCalledWith(
      expect.objectContaining({
        deploymentId: "rollback",
        sourceRevision: previous.BOB_RELEASE_SHA,
        phase: "rollback"
      })
    )
  })

  it("rolls back when the released Runtime does not become ready", async () => {
    const previous = {
      BOB_RELEASE_SHA: "b".repeat(40),
      BOB_AGENT_IMAGE_DIGEST: digest("5"),
      BOB_BACKUP_IMAGE_DIGEST: digest("6"),
      CLOUDFLARED_IMAGE_DIGEST: digest("7"),
      BOB_OBSERVER_IMAGE_DIGEST: digest("8")
    }
    const client = {
      currentEnvironment: vi.fn().mockResolvedValue(previous),
      updateSourceRevision: vi.fn().mockResolvedValue(undefined),
      updateEnvironment: vi.fn().mockResolvedValue(undefined),
      deploy: vi.fn().mockResolvedValueOnce("release").mockResolvedValueOnce("rollback"),
      waitForDeployment: vi.fn().mockResolvedValue(undefined)
    }
    const verifyReadiness = vi
      .fn()
      .mockRejectedValueOnce(new Error("release was not ready"))
      .mockResolvedValueOnce(undefined)

    await expect(releaseToCoolify({ client, bundle, verifyReadiness })).rejects.toThrow(
      "release was not ready"
    )
    expect(client.updateSourceRevision).toHaveBeenNthCalledWith(
      2,
      previous.BOB_RELEASE_SHA,
      expect.objectContaining({ deadline: expect.any(Number) })
    )
    expect(verifyReadiness).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        deploymentId: "rollback",
        sourceRevision: previous.BOB_RELEASE_SHA,
        phase: "rollback"
      })
    )
  })

  it("reserves a separate deadline for rollback", async () => {
    const previous = {
      BOB_RELEASE_SHA: "b".repeat(40),
      BOB_AGENT_IMAGE_DIGEST: digest("5"),
      BOB_BACKUP_IMAGE_DIGEST: digest("6"),
      CLOUDFLARED_IMAGE_DIGEST: digest("7"),
      BOB_OBSERVER_IMAGE_DIGEST: digest("8")
    }
    const client = {
      currentEnvironment: vi.fn().mockResolvedValue(previous),
      updateSourceRevision: vi.fn().mockResolvedValue(undefined),
      updateEnvironment: vi.fn().mockResolvedValue(undefined),
      deploy: vi.fn().mockResolvedValueOnce("release").mockResolvedValueOnce("rollback"),
      waitForDeployment: vi
        .fn()
        .mockRejectedValueOnce(new Error("release deadline"))
        .mockResolvedValueOnce(undefined)
    }
    const verifyReadiness = vi.fn().mockResolvedValue(undefined)

    await expect(
      releaseToCoolify({
        client,
        bundle,
        verifyReadiness,
        timingOptions: {
          now: () => 1_000,
          releaseBudgetMs: 100,
          rollbackBudgetMs: 200
        }
      })
    ).rejects.toThrow("release deadline")
    expect(client.waitForDeployment).toHaveBeenNthCalledWith(
      1,
      "release",
      bundle.sourceRevision,
      expect.objectContaining({ deadline: 1_100 })
    )
    expect(client.waitForDeployment).toHaveBeenNthCalledWith(
      2,
      "rollback",
      previous.BOB_RELEASE_SHA,
      expect.objectContaining({ deadline: 1_200 })
    )
  })

  it("keeps both errors when release and rollback readiness fail", async () => {
    const previous = {
      BOB_RELEASE_SHA: "b".repeat(40),
      BOB_AGENT_IMAGE_DIGEST: digest("5"),
      BOB_BACKUP_IMAGE_DIGEST: digest("6"),
      CLOUDFLARED_IMAGE_DIGEST: digest("7"),
      BOB_OBSERVER_IMAGE_DIGEST: digest("8")
    }
    const releaseError = new Error("release was not ready")
    const rollbackError = new Error("rollback was not ready")
    const client = {
      currentEnvironment: vi.fn().mockResolvedValue(previous),
      updateSourceRevision: vi.fn().mockResolvedValue(undefined),
      updateEnvironment: vi.fn().mockResolvedValue(undefined),
      deploy: vi.fn().mockResolvedValueOnce("release").mockResolvedValueOnce("rollback"),
      waitForDeployment: vi.fn().mockResolvedValue(undefined)
    }
    const verifyReadiness = vi
      .fn()
      .mockRejectedValueOnce(releaseError)
      .mockRejectedValueOnce(rollbackError)

    try {
      await releaseToCoolify({ client, bundle, verifyReadiness })
      expect.unreachable("The release must fail")
    } catch (error) {
      if (!(error instanceof AggregateError)) throw error
      expect(error.errors).toEqual([releaseError, rollbackError])
      expect(error.cause).toBe(releaseError)
    }
  })

  it("rejects an invalid prior release identity before changing Coolify", async () => {
    const client = {
      currentEnvironment: vi.fn().mockResolvedValue({
        BOB_RELEASE_SHA: "moving-branch",
        BOB_AGENT_IMAGE_DIGEST: digest("5"),
        BOB_BACKUP_IMAGE_DIGEST: digest("6"),
        CLOUDFLARED_IMAGE_DIGEST: digest("7"),
        BOB_OBSERVER_IMAGE_DIGEST: digest("8")
      }),
      updateSourceRevision: vi.fn(),
      updateEnvironment: vi.fn()
    }

    await expect(releaseToCoolify({ client, bundle, verifyReadiness: vi.fn() })).rejects.toThrow(
      "Prior release source revision is invalid"
    )
    expect(client.updateSourceRevision).not.toHaveBeenCalled()
    expect(client.updateEnvironment).not.toHaveBeenCalled()
  })
})
