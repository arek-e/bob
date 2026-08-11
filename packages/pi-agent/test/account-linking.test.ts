import type { AuthInteraction } from "@earendil-works/pi-ai"

import { beforeEach, describe, expect, it, vi } from "vitest"

import { createBobPiAgent } from "../src/index.ts"

const loginHarness = vi.hoisted(() => {
  let resolveLogin: (() => void) | undefined
  let credential: unknown
  const login = vi.fn(async (_provider: string, _method: string, interaction: AuthInteraction) => {
    interaction.notify({
      type: "device_code",
      verificationUri: "https://login.example.invalid/device",
      userCode: "ABCD-1234",
      expiresInSeconds: 900
    })
    await new Promise<void>((resolve) => {
      resolveLogin = resolve
    })
    credential = {
      type: "oauth",
      access: "access-token",
      refresh: "refresh-token",
      expires: Date.parse("2026-08-11T12:30:00.000Z"),
      accountId: "account-1234"
    }
  })
  return {
    login,
    readCredential: () => credential,
    complete: () => resolveLogin?.(),
    reset() {
      resolveLogin = undefined
      credential = undefined
      login.mockClear()
    }
  }
})

vi.mock("@earendil-works/pi-ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-ai")>()
  return {
    ...actual,
    createModels: () => ({
      setProvider: vi.fn(),
      getModel: vi.fn(() => ({ id: "gpt-test" })),
      login: loginHarness.login
    })
  }
})

vi.mock("@earendil-works/pi-ai/bun-oauth", () => ({
  registerBunOAuthFlows: vi.fn()
}))

vi.mock("@earendil-works/pi-ai/providers/openai-codex", () => ({
  openaiCodexProvider: vi.fn(() => ({}))
}))

beforeEach(() => {
  loginHarness.reset()
})

describe("Codex account linking", () => {
  it("retains the device code and final completion state", async () => {
    const agent = createBobPiAgent({
      credentials: { read: async () => loginHarness.readCredential() } as never,
      provider: "openai-codex",
      model: "gpt-test",
      allowedModels: ["gpt-test"],
      executeTool: vi.fn(),
      now: () => Date.parse("2026-08-11T12:00:00.000Z")
    })

    await expect(agent.getDeviceLoginStatus()).resolves.toEqual({ type: "idle" })
    await expect(agent.startDeviceLogin()).resolves.toEqual({
      type: "device_code",
      verificationUri: "https://login.example.invalid/device",
      userCode: "ABCD-1234",
      expiresAt: "2026-08-11T12:15:00.000Z"
    })
    await expect(agent.getDeviceLoginStatus()).resolves.toMatchObject({
      type: "device_code",
      userCode: "ABCD-1234"
    })

    loginHarness.complete()
    await vi.waitFor(async () => {
      await expect(agent.getDeviceLoginStatus()).resolves.toEqual({
        type: "completed",
        accountIdRedacted: "…1234",
        expiresAt: "2026-08-11T12:30:00.000Z"
      })
    })
  })
})
