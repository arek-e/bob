import type { ConnectionProvider } from "@bob/contracts/settings"

import { Schema } from "effect"

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

const NonEmptyString = Schema.String.check(Schema.isMinLength(1))
const Provider = Schema.Literals(["google_calendar", "microsoft_calendar"])
const ConnectSessionResponse = Schema.Struct({
  connectUrl: NonEmptyString,
  expiresAt: NonEmptyString
})
const ConnectionsResponse = Schema.Struct({
  connections: Schema.Array(
    Schema.Struct({
      connectionId: NonEmptyString,
      provider: Provider,
      createdAt: NonEmptyString,
      healthy: Schema.Boolean
    })
  )
})

export function makeConnectionsGatewayClient(
  options: ConnectionsGatewayClientOptions
): ConnectionsGatewayClient {
  const request = options.fetch ?? fetch
  const baseUrl = new URL(options.url)
  if (baseUrl.protocol !== "https:" && baseUrl.hostname !== "localhost") {
    throw new Error("Connections Gateway URL must use HTTPS")
  }
  const timeoutMs = options.timeoutMs ?? 10_000

  async function call<S extends Schema.ConstraintDecoder<unknown>>(
    schema: S,
    path: string,
    init?: RequestInit
  ): Promise<S["Type"]> {
    const headers = new Headers({
      accept: "application/json",
      "cf-access-client-id": options.accessClientId,
      "cf-access-client-secret": options.accessClientSecret
    })
    if (init?.body !== undefined) headers.set("content-type", "application/json")
    const response = await request(new URL(path, baseUrl), {
      ...init,
      headers,
      signal: AbortSignal.timeout(timeoutMs)
    })
    if (!response.ok)
      throw new Error(`Connections Gateway request failed with status ${response.status}`)
    return Schema.decodeUnknownSync(schema)(await response.json())
  }

  return {
    async createConnectSession(input) {
      const response = await call(ConnectSessionResponse, "/v1/connect-sessions", {
        method: "POST",
        body: JSON.stringify(input)
      })
      return {
        connectUrl: response.connectUrl,
        expiresAt: response.expiresAt
      }
    },

    async listConnections(ownerId) {
      const query = new URLSearchParams({ ownerId })
      const response = await call(ConnectionsResponse, `/v1/connections?${query.toString()}`)
      return response.connections
    }
  }
}
