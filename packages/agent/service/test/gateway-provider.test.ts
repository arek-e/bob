import type { Provider } from "@earendil-works/pi-ai"

import { AgentToolError } from "@bob/agent-types"
import { transitionalDeploymentProfile } from "@bob/deployment-profile-types/profiles"
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai"
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex"
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter"
import { Effect } from "effect"
import { describe, expect, it, vi } from "vitest"

import { createPiAgent, type PiAgentDependencies } from "../src/internal/pi-runtime.ts"

describe("LiteLLM gateway provider", () => {
  it("uses the OpenAI Responses adapter with the product virtual key", async () => {
    let configuredProvider: Provider | undefined
    const dependencies: PiAgentDependencies = {
      createModels: () => ({
        setProvider: vi.fn((provider) => {
          configuredProvider = provider
        }),
        getModel: vi.fn(() => ({
          ...openaiProvider()
            .getModels()
            .find((model) => model.id === "gpt-5.4")!,
          id: "gpt-5.4",
          provider: "litellm",
          baseUrl: "https://ai-gateway.example.invalid/v1"
        })),
        completeSimple: vi.fn(),
        login: vi.fn()
      }),
      openaiProvider,
      openaiCodexProvider,
      openrouterProvider,
      registerOAuthFlows: vi.fn()
    }

    const agent = createPiAgent({
      catalogue: transitionalDeploymentProfile,
      // SAFETY: The test does not make a credential-store call.
      credentials: { read: async () => undefined } as never,
      provider: "litellm",
      model: "gpt-5.4",
      allowedModels: ["gpt-5.4"],
      gateway: {
        baseUrl: "https://ai-gateway.example.invalid/v1",
        apiKey: "test-product-virtual-key"
      },
      executeTool: () => Effect.fail(new AgentToolError({ message: "No Tools in this test" })),
      dependencies
    })

    expect(configuredProvider).toMatchObject({
      id: "litellm",
      baseUrl: "https://ai-gateway.example.invalid/v1"
    })
    expect(configuredProvider?.getModels().every((model) => model.provider === "litellm")).toBe(
      true
    )
    const auth = await configuredProvider?.auth.apiKey?.resolve({
      ctx: { env: async () => undefined, fileExists: async () => false },
      signal: AbortSignal.timeout(1_000)
    })
    expect(auth).toEqual({
      auth: { apiKey: "test-product-virtual-key" },
      source: "BOB_GATEWAY_API_KEY"
    })
    await expect(Effect.runPromise(agent.getAuthStatus())).resolves.toEqual({
      configured: true,
      provider: "litellm"
    })

    agent.dispose()
  })
})
