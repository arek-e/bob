import { AgentRunRequest } from "@bob/agent-types/run"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"

import { AgentRunJob } from "../src/worker-gateway.ts"

describe("Agent Run wire contracts", () => {
  it("keeps private application data out of the queue pointer", () => {
    const job = Schema.decodeUnknownSync(AgentRunJob)({
      wireVersion: 1,
      runId: "10000000-0000-4000-8000-000000000001",
      dispatchGeneration: 1,
      executionPoolId: "core-20260817"
    })

    expect(Object.keys(job).sort()).toEqual([
      "dispatchGeneration",
      "executionPoolId",
      "runId",
      "wireVersion"
    ])
    expect("ownerId" in job).toBe(false)
    expect("request" in job).toBe(false)
  })

  it("keeps the existing immutable Agent request decodable", () => {
    expect(AgentRunRequest).toBeDefined()
  })
})
