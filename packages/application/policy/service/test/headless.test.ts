import { authorizeHeadlessApiRequest } from "@bob/policy-service/headless"
import { describe, expect, it } from "vitest"

const apiKey = "h".repeat(64)
const ownerId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db90"

describe("headless API authorization", () => {
  it("accepts a bearer credential and returns its configured owner scope", async () => {
    await expect(
      authorizeHeadlessApiRequest(
        new Request("https://core.example/api/production-data/messages", {
          headers: { authorization: `Bearer ${apiKey}` }
        }),
        { apiKey, ownerId }
      )
    ).resolves.toEqual({ ownerId })
  })

  it.each([
    new Request("https://core.example/api/production-data/messages"),
    new Request("https://core.example/api/production-data/messages", {
      headers: { authorization: "Basic not-a-bearer" }
    }),
    new Request("https://core.example/api/production-data/messages", {
      headers: { authorization: "Bearer wrong" }
    })
  ])("rejects a missing or invalid bearer credential", async (request) => {
    await expect(authorizeHeadlessApiRequest(request, { apiKey, ownerId })).rejects.toThrow(
      "access_denied"
    )
  })
})
