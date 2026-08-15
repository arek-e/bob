import { describe, expect, it, vi } from "vitest"

import { makeConnectionsGatewayClient } from "../src/modules/connections/gateway.ts"

describe("Connections Gateway client", () => {
  it("creates an owner-scoped Connect session with Instance credentials", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        connectUrl: "https://nango-connect.example/connect/session",
        expiresAt: "2026-08-15T12:10:00.000Z"
      })
    )
    const client = makeConnectionsGatewayClient({
      url: "https://connections.example",
      accessClientId: "instance-client",
      accessClientSecret: "instance-secret",
      fetch: request
    })

    await expect(
      client.createConnectSession({ ownerId: "owner-1", provider: "google_calendar" })
    ).resolves.toEqual({
      connectUrl: "https://nango-connect.example/connect/session",
      expiresAt: "2026-08-15T12:10:00.000Z"
    })

    const [url, init] = request.mock.calls[0] ?? []
    expect(String(url)).toBe("https://connections.example/v1/connect-sessions")
    expect(init?.headers).toMatchObject({
      "cf-access-client-id": "instance-client",
      "cf-access-client-secret": "instance-secret"
    })
    expect(JSON.parse(String(init?.body))).toEqual({
      ownerId: "owner-1",
      provider: "google_calendar"
    })
  })

  it("lists only the gateway response fields", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        connections: [
          {
            connectionId: "calendar-1",
            provider: "google_calendar",
            createdAt: "2026-08-15T12:00:00.000Z",
            healthy: true,
            tags: { secret: "not-used" }
          }
        ]
      })
    )
    const client = makeConnectionsGatewayClient({
      url: "https://connections.example",
      accessClientId: "instance-client",
      accessClientSecret: "instance-secret",
      fetch: request
    })

    await expect(client.listConnections("owner-1")).resolves.toEqual([
      {
        connectionId: "calendar-1",
        provider: "google_calendar",
        createdAt: "2026-08-15T12:00:00.000Z",
        healthy: true
      }
    ])
  })

  it("requires HTTPS outside localhost", () => {
    expect(() =>
      makeConnectionsGatewayClient({
        url: "http://connections.example",
        accessClientId: "instance-client",
        accessClientSecret: "instance-secret"
      })
    ).toThrow("Connections Gateway URL must use HTTPS")
  })
})
