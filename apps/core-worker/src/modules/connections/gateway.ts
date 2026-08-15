import type { ConnectionProvider } from "@bob/contracts/settings"

export interface ProviderConnection {
  readonly connectionId: string
  readonly provider: ConnectionProvider
  readonly createdAt: string
  readonly healthy: boolean
}

export interface ProviderConnectSession {
  readonly connectUrl: string
  readonly expiresAt: string
}

export interface ConnectionsGatewayClient {
  createConnectSession(input: {
    readonly ownerId: string
    readonly provider: ConnectionProvider
  }): Promise<ProviderConnectSession>
  listConnections(ownerId: string): Promise<ReadonlyArray<ProviderConnection>>
}

interface ConnectionsGatewayClientOptions {
  readonly url: string
  readonly accessClientId: string
  readonly accessClientSecret: string
  readonly fetch?: typeof fetch
  readonly timeoutMs?: number
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Connections Gateway returned an invalid ${field}`)
  }
  return value
}

function provider(value: unknown): ConnectionProvider {
  if (value !== "google_calendar" && value !== "microsoft_calendar") {
    throw new Error("Connections Gateway returned an invalid provider")
  }
  return value
}

export function makeConnectionsGatewayClient(
  options: ConnectionsGatewayClientOptions
): ConnectionsGatewayClient {
  const request = options.fetch ?? fetch
  const baseUrl = new URL(options.url)
  if (baseUrl.protocol !== "https:" && baseUrl.hostname !== "localhost") {
    throw new Error("Connections Gateway URL must use HTTPS")
  }
  const timeoutMs = options.timeoutMs ?? 10_000

  async function call(path: string, init?: RequestInit): Promise<unknown> {
    const response = await request(new URL(path, baseUrl), {
      ...init,
      headers: {
        accept: "application/json",
        "cf-access-client-id": options.accessClientId,
        "cf-access-client-secret": options.accessClientSecret,
        ...(init?.body === undefined ? {} : { "content-type": "application/json" })
      },
      signal: AbortSignal.timeout(timeoutMs)
    })
    if (!response.ok)
      throw new Error(`Connections Gateway request failed with status ${response.status}`)
    return response.status === 204 ? undefined : response.json()
  }

  return {
    async createConnectSession(input) {
      const response = record(
        await call("/v1/connect-sessions", {
          method: "POST",
          body: JSON.stringify(input)
        })
      )
      return {
        connectUrl: requiredString(response?.connectUrl, "connect URL"),
        expiresAt: requiredString(response?.expiresAt, "connect session expiry")
      }
    },

    async listConnections(ownerId) {
      const query = new URLSearchParams({ ownerId })
      const response = record(await call(`/v1/connections?${query.toString()}`))
      const connections = response?.connections
      if (!Array.isArray(connections)) {
        throw new Error("Connections Gateway returned an invalid connection list")
      }
      return connections.map((value) => {
        const connection = record(value)
        if (connection === undefined) {
          throw new Error("Connections Gateway returned an invalid connection")
        }
        return {
          connectionId: requiredString(connection.connectionId, "connection ID"),
          provider: provider(connection.provider),
          createdAt: requiredString(connection.createdAt, "connection date"),
          healthy: connection.healthy === true
        }
      })
    }
  }
}
