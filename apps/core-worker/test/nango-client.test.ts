import { describe, expect, it, vi } from "vitest"

import { makeNangoClient } from "../src/modules/connections/nango.ts"

describe("Nango client", () => {
  it("creates an owner-scoped Connect session", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        data: {
          token: "connect-token",
          connect_link: "https://nango-connect.example/connect/session",
          expires_at: "2026-08-11T12:10:00.000Z"
        }
      })
    )
    const client = makeNangoClient({
      apiUrl: "https://nango.example",
      secretKey: "secret-key",
      fetch: request
    })

    await expect(
      client.createConnectSession({
        ownerId: "owner-1",
        integrationId: "bob-google-calendar"
      })
    ).resolves.toEqual({
      token: "connect-token",
      connectUrl:
        "https://nango-connect.example/connect/session?apiURL=https%3A%2F%2Fnango.example",
      expiresAt: "2026-08-11T12:10:00.000Z"
    })

    const [url, init] = request.mock.calls[0] ?? []
    expect(String(url)).toBe("https://nango.example/connect/sessions")
    expect(init?.headers).toMatchObject({
      authorization: "Bearer secret-key",
      "content-type": "application/json"
    })
    expect(JSON.parse(String(init?.body))).toEqual({
      tags: { end_user_id: "owner-1" },
      allowed_integrations: ["bob-google-calendar"]
    })
  })

  it("lists connections with the owner tag filter", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        connections: [
          {
            connection_id: "calendar-1",
            provider_config_key: "bob-google-calendar",
            created_at: "2026-08-11T12:00:00.000Z",
            tags: { end_user_id: "owner-1" },
            errors: []
          }
        ]
      })
    )
    const client = makeNangoClient({
      apiUrl: "https://nango.example",
      secretKey: "secret-key",
      fetch: request
    })

    await expect(client.listConnections("owner-1")).resolves.toEqual([
      {
        connectionId: "calendar-1",
        integrationId: "bob-google-calendar",
        createdAt: "2026-08-11T12:00:00.000Z",
        tags: { end_user_id: "owner-1" },
        healthy: true
      }
    ])

    const [url] = request.mock.calls[0] ?? []
    expect(String(url)).toBe(
      "https://nango.example/connections?limit=100&tags%5Bend_user_id%5D=owner-1"
    )
  })

  it("requires HTTPS outside localhost", () => {
    expect(() =>
      makeNangoClient({ apiUrl: "http://nango.example", secretKey: "secret-key" })
    ).toThrow("Nango API URL must use HTTPS")
  })
})
