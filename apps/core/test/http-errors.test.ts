import type { CoreBindings } from "@bob/core-types/bindings"

import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import type { CoreComposition } from "../src/composition.ts"

import { testFixture } from "../../../packages/core/service/test/test-fixture.ts"
import { handleHttp } from "../src/entrypoints/http.ts"

describe("Core HTTP failures", () => {
  it("protects production inspection with its dedicated operator token", async () => {
    const operatorSecret = "o".repeat(64)
    const bindings = testFixture<CoreBindings>({
      INGRESS_CALLER_SECRET: "i".repeat(64),
      EGRESS_CALLER_SECRET: "e".repeat(64),
      AGENT_CALLER_SECRET: "a".repeat(64),
      PRODUCTION_DATA_INSPECTOR_SECRET: operatorSecret
    })
    const composition = testFixture<CoreComposition>({
      services: {
        productionData: {
          summary: async () => ({
            from: "2026-08-23T00:00:00.000Z",
            to: "2026-08-24T00:00:00.000Z",
            totalMessages: 0,
            totalOwners: 0,
            totalAgentRuns: 0,
            totalToolCalls: 0,
            messageDirections: [],
            inboundEventStates: [],
            agentRunStates: [],
            deliveryStates: [],
            toolCallStates: [],
            owners: []
          }),
          workflow: async (correlationId: string) => ({
            correlationId,
            inboundEvents: [],
            agentRuns: [],
            outboxMessages: [],
            deliveryAttempts: [],
            toolCalls: []
          })
        }
      }
    })
    const request = (token: string) =>
      new Request("https://core.test/internal/production-data/summary", {
        headers: { "x-bob-caller-token": token }
      })

    const unauthorized = await handleHttp(request("wrong"), bindings, () => composition)
    expect(unauthorized.status).toBe(401)

    const authorized = await handleHttp(request(operatorSecret), bindings, () => composition)
    expect(authorized.status).toBe(200)
    expect(await authorized.json()).toMatchObject({ totalMessages: 0 })
  })

  it("does not treat an operator token as owner authorization for message content", async () => {
    const operatorSecret = "o".repeat(64)
    const bindings = testFixture<CoreBindings>({
      PRODUCTION_DATA_INSPECTOR_SECRET: operatorSecret
    })
    const composition = testFixture<CoreComposition>({ services: {} })
    const response = await handleHttp(
      new Request("https://core.test/api/production-data/messages", {
        headers: { "x-bob-caller-token": operatorSecret }
      }),
      bindings,
      () => composition
    )

    expect(response.status).toBe(401)
  })

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

  it("requests object rows for owner enrollment conflicts", async () => {
    const ownerEnrollmentSecret = "o".repeat(64)
    const requestedOwnerId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db9f"
    const bindings = testFixture<CoreBindings>({
      OWNER_ENROLLMENT_SECRET: ownerEnrollmentSecret,
      DB: {
        execute: (...arguments_: Parameters<CoreBindings["DB"]["execute"]>) => {
          expect(arguments_[1]).toBe("objects")
          return Effect.succeed([
            {
              id: "018e6f65-4d55-7a1b-8df4-4ee15ea1dba0",
              email: "existing@example.test"
            }
          ])
        }
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
