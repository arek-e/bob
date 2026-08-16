import type { AgentRunRequest } from "@bob/core-types/agent"

import { AgentToolError, BobAgent } from "@bob/agent-types"
import { transitionalDeploymentProfile } from "@bob/core-types/profiles"
import { fauxAssistantMessage } from "@earendil-works/pi-ai"
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import { expect, vi } from "vitest"

import {
  piAgentLayerWithDependencies,
  type PiAgentDependencies
} from "../src/internal/pi-runtime.ts"

const request: AgentRunRequest = {
  protocolVersion: 1,
  runId: "00000000-0000-4000-8000-000000000001",
  ownerId: "00000000-0000-4000-8000-000000000002",
  correlationId: "00000000-0000-4000-8000-000000000003",
  sourceMessageId: "00000000-0000-4000-8000-000000000004",
  localTime: "2026-08-17T12:00:00.000Z",
  timeZone: "Europe/Stockholm",
  userText: "Hello Bob",
  contextItems: [],
  allowedTools: [],
  limits: {
    maxTurns: 2,
    maxToolCalls: 1,
    maxDurationMs: 30_000,
    maxResponseCharacters: 500
  }
}

const dependencies: PiAgentDependencies = {
  createModels: () => ({
    setProvider: vi.fn(),
    getModel: vi.fn(() => ({
      id: "gpt-test",
      name: "Test model",
      api: "openai-codex-responses" as const,
      provider: "openai-codex",
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      input: ["text" as const],
      contextWindow: 128_000,
      maxTokens: 4_096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    })),
    completeSimple: vi.fn(async () =>
      fauxAssistantMessage(
        JSON.stringify({
          protocolVersion: 1,
          responseText: "Ready.",
          sourceIds: [],
          toolNames: [],
          conflict: "none"
        }),
        { stopReason: "stop" }
      )
    ),
    login: vi.fn()
  }),
  openaiCodexProvider,
  registerOAuthFlows: vi.fn()
}

const layer = piAgentLayerWithDependencies({
  catalogue: transitionalDeploymentProfile,
  credentials: { read: async () => undefined } as never,
  provider: "openai-codex",
  model: "gpt-test",
  allowedModels: ["gpt-test"],
  executeTool: () =>
    Effect.fail(new AgentToolError({ message: "The test does not permit Tool execution" })),
  dependencies,
  now: () => 1
})

it.effect("runs the Agent through its scoped Effect Interface", () =>
  BobAgent.use((agent) => agent.runTurn(request)).pipe(
    Effect.tap((result) =>
      Effect.sync(() => {
        expect(result).toMatchObject({ status: "completed", responseText: "Ready." })
      })
    ),
    Effect.provide(layer)
  )
)
