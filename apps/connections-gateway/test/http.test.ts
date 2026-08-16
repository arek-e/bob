import { describe, expect, it, vi } from "vitest"

import type { ConnectionsProvider } from "../src/nango.ts"

import { gatewayFailure, type GatewayFailureCode } from "../src/failure.ts"
import { createConnectionsGateway } from "../src/http.ts"

function provider(): ConnectionsProvider {
  return {
    createSession: vi.fn().mockResolvedValue({
      connectUrl: "https://connect.example/session",
      expiresAt: "2026-08-15T12:00:00.000Z"
    }),
    list: vi.fn().mockResolvedValue([])
  }
}

describe("Connections Gateway HTTP Interface", () => {
  it("derives Instance scope from the authenticated caller", async () => {
    const connections = provider()
    const handle = createConnectionsGateway({
      authenticator: { authenticate: async () => ({ instanceId: "instance-a" }) },
      connections
    })

    const response = await handle(
      new Request("https://connections.example/v1/connect-sessions", {
        method: "POST",
        body: JSON.stringify({
          instanceId: "instance-b",
          ownerId: "owner-1",
          provider: "google_calendar"
        })
      })
    )

    expect(response.status).toBe(201)
    expect(connections.createSession).toHaveBeenCalledWith({
      instanceId: "instance-a",
      ownerId: "owner-1",
      provider: "google_calendar"
    })
  })

  it("rejects unsupported providers", async () => {
    const connections = provider()
    const handle = createConnectionsGateway({
      authenticator: { authenticate: async () => ({ instanceId: "instance-a" }) },
      connections
    })
    const response = await handle(
      new Request("https://connections.example/v1/connect-sessions", {
        method: "POST",
        body: JSON.stringify({ ownerId: "owner-1", provider: "arbitrary-provider" })
      })
    )

    expect(response.status).toBe(400)
    expect(connections.createSession).not.toHaveBeenCalled()
  })

  it("fails closed when caller authentication fails", async () => {
    const handle = createConnectionsGateway({
      authenticator: {
        authenticate: async () => {
          throw gatewayFailure("access_denied")
        }
      },
      connections: provider()
    })
    const response = await handle(
      new Request("https://connections.example/v1/connections?ownerId=owner-1")
    )

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ code: "access_denied" })
  })

  it.each([
    ["access_denied", 401],
    ["invalid_request", 400],
    ["body_too_large", 413],
    ["provider_unavailable", 502],
    ["internal_error", 500]
  ] satisfies ReadonlyArray<readonly [GatewayFailureCode, number]>)(
    "maps %s to HTTP %i",
    async (code, status) => {
      const handle = createConnectionsGateway({
        authenticator: { authenticate: async () => ({ instanceId: "instance-a" }) },
        connections: {
          ...provider(),
          list: async () => {
            throw gatewayFailure(code)
          }
        }
      })

      const response = await handle(
        new Request("https://connections.example/v1/connections?ownerId=owner-1")
      )

      expect(response.status).toBe(status)
      await expect(response.json()).resolves.toEqual({ code })
    }
  )

  it("does not classify or return an incidental provider error message", async () => {
    const handle = createConnectionsGateway({
      authenticator: { authenticate: async () => ({ instanceId: "instance-a" }) },
      connections: {
        ...provider(),
        list: async () => {
          throw new Error("connections_provider_unavailable: upstream secret")
        }
      }
    })

    const response = await handle(
      new Request("https://connections.example/v1/connections?ownerId=owner-1")
    )

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({ code: "internal_error" })
  })
})
