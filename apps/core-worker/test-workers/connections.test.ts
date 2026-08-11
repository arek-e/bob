import { applyD1Migrations, reset } from "cloudflare:test"
import { env } from "cloudflare:workers"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { NangoClient } from "../src/modules/connections/nango.ts"

import { createCoreDatabase } from "../src/database.ts"
import { makeAccountConnections } from "../src/modules/connections/store.ts"
import { decodeTestMigrations } from "./migrations.ts"

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database
      TEST_MIGRATIONS: string
    }
  }
}

const ownerId = "00000000-0000-4000-8000-000000000001"
const integrations = {
  google_calendar: "bob-google-calendar",
  microsoft_calendar: "bob-microsoft-calendar"
} as const

beforeEach(async () => {
  await applyD1Migrations(env.DB, decodeTestMigrations(env.TEST_MIGRATIONS))
})

afterEach(async () => {
  await reset()
})

describe("account connections", () => {
  it("reads saved state without contacting Nango and refreshes it explicitly", async () => {
    const listConnections = vi.fn<NangoClient["listConnections"]>().mockResolvedValue([
      {
        connectionId: "google-1",
        integrationId: integrations.google_calendar,
        createdAt: "2026-08-11T10:00:00.000Z",
        tags: { end_user_id: ownerId },
        healthy: true
      }
    ])
    const connections = makeAccountConnections(
      createCoreDatabase(env.DB),
      {
        listConnections,
        createConnectSession: vi.fn<NangoClient["createConnectSession"]>()
      },
      {
        integrations,
        sendblueStatus: async () => ({ provider: "sendblue", status: "connected" }),
        now: () => new Date("2026-08-11T10:05:00.000Z"),
        randomUuid: () => "00000000-0000-4000-8000-000000000002"
      }
    )

    await expect(connections.list(ownerId)).resolves.toEqual([
      { provider: "sendblue", status: "connected" },
      { provider: "google_calendar", status: "not_connected" },
      { provider: "microsoft_calendar", status: "not_connected" }
    ])
    expect(listConnections).not.toHaveBeenCalled()

    await expect(connections.refresh(ownerId)).resolves.toEqual([
      { provider: "sendblue", status: "connected" },
      { provider: "google_calendar", status: "connected" },
      { provider: "microsoft_calendar", status: "not_connected" }
    ])
  })

  it("keeps saved state when Nango is unavailable", async () => {
    const database = createCoreDatabase(env.DB)
    const healthy = makeAccountConnections(
      database,
      {
        listConnections: vi.fn<NangoClient["listConnections"]>().mockResolvedValue([
          {
            connectionId: "google-1",
            integrationId: integrations.google_calendar,
            createdAt: "2026-08-11T10:00:00.000Z",
            tags: { end_user_id: ownerId },
            healthy: true
          }
        ]),
        createConnectSession: vi.fn<NangoClient["createConnectSession"]>()
      },
      {
        integrations,
        sendblueStatus: async () => ({ provider: "sendblue", status: "connected" }),
        randomUuid: () => "00000000-0000-4000-8000-000000000002"
      }
    )
    await healthy.refresh(ownerId)

    const unavailable = makeAccountConnections(
      database,
      {
        listConnections: vi
          .fn<NangoClient["listConnections"]>()
          .mockRejectedValue(new Error("Nango unavailable")),
        createConnectSession: vi.fn<NangoClient["createConnectSession"]>()
      },
      {
        integrations,
        sendblueStatus: async () => ({ provider: "sendblue", status: "paused" })
      }
    )

    await expect(unavailable.refresh(ownerId)).resolves.toEqual([
      { provider: "sendblue", status: "paused" },
      { provider: "google_calendar", status: "stale" },
      { provider: "microsoft_calendar", status: "unavailable" }
    ])
    await expect(unavailable.list(ownerId)).resolves.toEqual([
      { provider: "sendblue", status: "paused" },
      { provider: "google_calendar", status: "connected" },
      { provider: "microsoft_calendar", status: "not_connected" }
    ])
  })
})
