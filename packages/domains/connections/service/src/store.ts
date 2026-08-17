import type {
  ConnectionProvider,
  ConnectionSession,
  ConnectionView
} from "@bob/connections-types/capability"
import type { CoreDatabase } from "@bob/db-types"

import { externalConnections } from "@bob/db-service/schema/connections"
import { and, eq } from "drizzle-orm"
import { Effect, Context, Layer } from "effect"

import type { ConnectionsGatewayClient, ProviderConnection } from "./gateway.ts"

export interface ConnectionStore {
  list(ownerId: string): Promise<readonly ConnectionView[]>
  createSession(ownerId: string, provider: ConnectionProvider): Promise<ConnectionSession>
}

export const ConnectionStore = Context.Service<ConnectionStore>("bob/ConnectionStore")

export interface ConnectionStoreOptions {
  readonly now?: () => Date
  readonly randomUuid?: () => string
}

function newestConnection(
  connections: readonly ProviderConnection[],
  provider: ConnectionProvider
): ProviderConnection | undefined {
  return connections
    .filter((connection) => connection.provider === provider)
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0]
}

export function makeConnectionStore(
  database: CoreDatabase,
  gateway: ConnectionsGatewayClient,
  options: ConnectionStoreOptions
): ConnectionStore {
  const now = options.now ?? (() => new Date())
  const randomUuid = options.randomUuid ?? (() => crypto.randomUUID())
  const providers: ReadonlyArray<ConnectionProvider> = ["google_calendar", "microsoft_calendar"]

  async function saved(ownerId: string) {
    return Effect.runPromise(
      database.select().from(externalConnections).where(eq(externalConnections.ownerId, ownerId))
    )
  }

  return {
    async list(ownerId) {
      let live: readonly ProviderConnection[]
      try {
        live = await gateway.listConnections(ownerId)
      } catch {
        return providers.map((provider) => ({
          provider,
          status: "unavailable"
        }))
      }

      const at = now().toISOString()
      for (const provider of providers) {
        const connection = newestConnection(live, provider)
        if (connection === undefined) {
          await Effect.runPromise(
            database
              .delete(externalConnections)
              .where(
                and(
                  eq(externalConnections.ownerId, ownerId),
                  eq(externalConnections.provider, provider)
                )
              )
          )
          continue
        }
        await Effect.runPromise(
          database
            .insert(externalConnections)
            .values({
              id: randomUuid(),
              ownerId,
              provider,
              integrationId: connection.provider,
              connectionId: connection.connectionId,
              status: connection.healthy ? "connected" : "unavailable",
              connectedAt: connection.createdAt,
              updatedAt: at
            })
            .onConflictDoUpdate({
              target: [externalConnections.ownerId, externalConnections.provider],
              set: {
                integrationId: connection.provider,
                connectionId: connection.connectionId,
                status: connection.healthy ? "connected" : "unavailable",
                connectedAt: connection.createdAt,
                updatedAt: at
              }
            })
        )
      }
      const rows = await saved(ownerId)
      return providers.map((provider) => ({
        provider,
        status: rows.find((row) => row.provider === provider)?.status ?? "not_connected"
      }))
    },

    async createSession(ownerId, provider) {
      const session = await gateway.createConnectSession({
        ownerId,
        provider
      })
      return {
        provider,
        connectUrl: session.connectUrl,
        expiresAt: session.expiresAt
      }
    }
  }
}

export function connectionStoreLayer(store: ConnectionStore) {
  return Layer.succeed(ConnectionStore, store)
}
