import type { CoreBindings } from "@bob/core-types/bindings"

import { Effect } from "effect"
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

  it("reads owner enrollment conflicts from an iterable PostgreSQL result", async () => {
    const ownerEnrollmentSecret = "o".repeat(64)
    const requestedOwnerId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db9f"
    const existingOwners = {
      *[Symbol.iterator]() {
        yield {
          id: "018e6f65-4d55-7a1b-8df4-4ee15ea1dba0",
          email: "existing@example.test"
        }
      }
    }
    const bindings = testFixture<CoreBindings>({
      OWNER_ENROLLMENT_SECRET: ownerEnrollmentSecret,
      DB: {
        execute: () => Effect.succeed(existingOwners)
      }
    })
    const composition = testFixture<CoreComposition>({ services: {} })

    const response = await handleHttp(
      new Request("https://core.test/internal/owners/enroll", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-bob-owner-enrollment-token": ownerEnrollmentSecret
        },
        body: JSON.stringify({
          ownerId: requestedOwnerId,
          email: "e2e@example.test",
          password: "synthetic-password",
          channel: {
            accountId: "account",
            lineId: "line",
            senderE164: "+46711111111",
            destinationE164: "+46722222222"
          }
        })
      }),
      bindings,
      () => composition
    )

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ code: "owner_identity_conflict" })
  })
})
