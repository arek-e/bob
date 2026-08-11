import type { DeviceLoginEvent, DeviceLoginState } from "@bob/contracts/agent"
import type {
  ConnectionProvider,
  ConnectionSession,
  SettingsConnection
} from "@bob/contracts/settings"

import { and, eq } from "drizzle-orm"
import { Context, Layer } from "effect"

import type { CoreDatabase } from "../../database.ts"
import type { AgentAccountClient } from "./agent-account.ts"
import type { NangoClient, NangoConnection } from "./nango.ts"

import { externalConnections } from "./schema.ts"

export interface AccountConnections {
  list(ownerId: string): Promise<readonly SettingsConnection[]>
  refresh(ownerId: string): Promise<readonly SettingsConnection[]>
  createSession(ownerId: string, provider: ConnectionProvider): Promise<ConnectionSession>
  getDeviceLoginStatus(): Promise<DeviceLoginState>
  startDeviceLogin(): Promise<DeviceLoginEvent>
}

export const AccountConnections = Context.Service<AccountConnections>("bob/AccountConnections")

export interface AccountConnectionsOptions {
  readonly integrations: Readonly<Record<ConnectionProvider, string>>
  readonly agentAccount: AgentAccountClient
  readonly sendblueStatus: (ownerId: string) => Promise<SettingsConnection>
  readonly now?: () => Date
  readonly randomUuid?: () => string
}

function newestConnection(
  connections: readonly NangoConnection[],
  integrationId: string,
  ownerId: string
): NangoConnection | undefined {
  return connections
    .filter(
      (connection) =>
        connection.integrationId === integrationId && connection.tags.end_user_id === ownerId
    )
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0]
}

export function makeAccountConnections(
  database: CoreDatabase,
  nango: NangoClient,
  options: AccountConnectionsOptions
): AccountConnections {
  const now = options.now ?? (() => new Date())
  const randomUuid = options.randomUuid ?? (() => crypto.randomUUID())
  const providers = Object.keys(options.integrations) as ConnectionProvider[]

  async function saved(ownerId: string) {
    return database
      .select()
      .from(externalConnections)
      .where(eq(externalConnections.ownerId, ownerId))
  }

  async function list(ownerId: string): Promise<readonly SettingsConnection[]> {
    const [sendblue, rows, agentStatus] = await Promise.all([
      options.sendblueStatus(ownerId),
      saved(ownerId),
      options.agentAccount.getStatus().catch(() => undefined)
    ])
    return [
      sendblue,
      agentStatus === undefined
        ? { provider: "openai_codex", status: "unavailable" }
        : {
            provider: "openai_codex",
            status: agentStatus.configured ? "connected" : "not_connected",
            ...(agentStatus.accountIdRedacted === undefined
              ? {}
              : { accountIdRedacted: agentStatus.accountIdRedacted }),
            ...(agentStatus.expiresAt === undefined ? {} : { expiresAt: agentStatus.expiresAt })
          },
      ...providers.map((provider): SettingsConnection => ({
        provider,
        status: rows.find((row) => row.provider === provider)?.status ?? "not_connected"
      }))
    ]
  }

  return {
    list,

    async refresh(ownerId) {
      let live: readonly NangoConnection[]
      try {
        live = await nango.listConnections(ownerId)
      } catch {
        return (await list(ownerId)).map((connection) =>
          connection.provider === "sendblue" || connection.provider === "openai_codex"
            ? connection
            : {
                ...connection,
                status: connection.status === "connected" ? "stale" : "unavailable"
              }
        )
      }

      const at = now().toISOString()
      for (const provider of providers) {
        const connection = newestConnection(live, options.integrations[provider], ownerId)
        if (connection === undefined) {
          await database
            .delete(externalConnections)
            .where(
              and(
                eq(externalConnections.ownerId, ownerId),
                eq(externalConnections.provider, provider)
              )
            )
          continue
        }
        await database
          .insert(externalConnections)
          .values({
            id: randomUuid(),
            ownerId,
            provider,
            integrationId: connection.integrationId,
            connectionId: connection.connectionId,
            status: connection.healthy ? "connected" : "unavailable",
            connectedAt: connection.createdAt,
            updatedAt: at
          })
          .onConflictDoUpdate({
            target: [externalConnections.ownerId, externalConnections.provider],
            set: {
              integrationId: connection.integrationId,
              connectionId: connection.connectionId,
              status: connection.healthy ? "connected" : "unavailable",
              connectedAt: connection.createdAt,
              updatedAt: at
            }
          })
      }
      return list(ownerId)
    },

    async createSession(ownerId, provider) {
      const session = await nango.createConnectSession({
        ownerId,
        integrationId: options.integrations[provider]
      })
      return {
        provider,
        connectUrl: session.connectUrl,
        expiresAt: session.expiresAt
      }
    },

    getDeviceLoginStatus: () => options.agentAccount.getDeviceLoginStatus(),
    startDeviceLogin: () => options.agentAccount.startDeviceLogin()
  }
}

export function accountConnectionsLayer(connections: AccountConnections) {
  return Layer.succeed(AccountConnections, connections)
}
