import { describe, expect, it, vi } from "vitest"

import { createNangoProvider, scopedOwnerId } from "../src/nango.ts"

const integrations = {
  google_calendar: "bob-google-calendar",
  microsoft_calendar: "bob-microsoft-calendar"
} as const

describe("shared Nango provider", () => {
  it("uses a stable and unambiguous Instance-scoped owner reference", () => {
    expect(scopedOwnerId("a:b", "c")).not.toBe(scopedOwnerId("a", "b:c"))
    expect(scopedOwnerId("instance-a", "owner-1")).toBe("bob:v1:WyJpbnN0YW5jZS1hIiwib3duZXItMSJd")
  })

  it("filters an upstream response again before returning metadata", async () => {
    const expectedOwner = scopedOwnerId("instance-a", "owner-1")
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        connections: [
          {
            connection_id: "allowed",
            provider_config_key: "bob-google-calendar",
            created_at: "2026-08-15T10:00:00.000Z",
            tags: { end_user_id: expectedOwner, secret: "must-not-return" },
            errors: []
          },
          {
            connection_id: "other-instance",
            provider_config_key: "bob-google-calendar",
            created_at: "2026-08-15T10:00:00.000Z",
            tags: { end_user_id: scopedOwnerId("instance-b", "owner-1") },
            errors: []
          }
        ]
      })
    )
    const nango = createNangoProvider({
      apiUrl: "https://nango.example",
      secretKey: "environment-secret",
      integrations,
      fetch: request
    })

    await expect(nango.list({ instanceId: "instance-a", ownerId: "owner-1" })).resolves.toEqual([
      {
        provider: "google_calendar",
        connectionId: "allowed",
        createdAt: "2026-08-15T10:00:00.000Z",
        healthy: true
      }
    ])
  })

  it("does not return the Nango Connect token", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        data: {
          token: "do-not-return",
          connect_link: "https://connect.example/session",
          expires_at: "2026-08-15T12:00:00.000Z"
        }
      })
    )
    const nango = createNangoProvider({
      apiUrl: "https://nango.example",
      secretKey: "environment-secret",
      integrations,
      fetch: request
    })

    await expect(
      nango.createSession({
        instanceId: "instance-a",
        ownerId: "owner-1",
        provider: "google_calendar"
      })
    ).resolves.toEqual({
      connectUrl: "https://connect.example/session?apiURL=https%3A%2F%2Fnango.example",
      expiresAt: "2026-08-15T12:00:00.000Z"
    })
  })
})
