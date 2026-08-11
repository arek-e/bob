import { describe, expect, it } from "vitest"

import { createTools } from "../src/tools.ts"

describe("Pi training tools", () => {
  it("exposes the complete training setup and recall surface", () => {
    const allowedTools = [
      "exercise_create",
      "equipment_map_exercise",
      "routine_get",
      "workout_last"
    ] as const
    const tools = createTools({
      request: {
        protocolVersion: 1,
        runId: "00000000-0000-4000-8000-000000000001",
        ownerId: "00000000-0000-4000-8000-000000000002",
        correlationId: "00000000-0000-4000-8000-000000000003",
        localTime: "2026-08-11T10:00:00.000Z",
        timeZone: "Europe/Stockholm",
        userText: "Set up my training equipment.",
        contextItems: [],
        allowedTools: [...allowedTools],
        limits: {
          maxTurns: 4,
          maxToolCalls: 4,
          maxDurationMs: 60_000,
          maxResponseCharacters: 1_200
        }
      },
      execute: async () => ({ ok: true, code: "test", message: "Test." })
    })
    expect(tools.map((tool) => tool.name)).toEqual([...allowedTools])
  })
})
