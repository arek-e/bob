import type { CoreBindings } from "@bob/core-types/bindings"

import { describe, expect, it } from "vitest"

import type { CoreComposition } from "../src/composition.ts"

import { testFixture } from "../../../packages/core/service/test/test-fixture.ts"
import { handleHttp } from "../src/entrypoints/http.ts"

describe("Core HTTP failures", () => {
  it("rejects an oversized request body", async () => {
    const agentSecret = "a".repeat(64)
    const bindings = testFixture<CoreBindings>({
      INGRESS_CALLER_SECRET: "i".repeat(64),
      EGRESS_CALLER_SECRET: "e".repeat(64),
      AGENT_CALLER_SECRET: agentSecret
    })
    const composition = testFixture<CoreComposition>({ services: {} })
    const response = await handleHttp(
      new Request("https://core.test/internal/agent/result", {
        method: "POST",
        headers: {
          "content-length": String(64 * 1024 + 1),
          "x-bob-caller-token": agentSecret
        },
        body: "{}"
      }),
      bindings,
      () => composition
    )

    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({ code: "body_too_large" })
  })
})
