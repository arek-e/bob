import { isJsonObject, type JsonObject, type JsonValue } from "./json.ts"

export type ConnectionProvider = "google_calendar" | "microsoft_calendar"

export interface GatewayConnection {
  readonly provider: ConnectionProvider
  readonly connectionId: string
  readonly createdAt: string
  readonly healthy: boolean
}

export interface GatewayConnectSession {
  readonly connectUrl: string
  readonly expiresAt: string
}

export interface ConnectionsProvider {
  createSession(input: {
    readonly instanceId: string
    readonly ownerId: string
    readonly provider: ConnectionProvider
  }): Promise<GatewayConnectSession>
  list(input: {
    readonly instanceId: string
    readonly ownerId: string
  }): Promise<ReadonlyArray<GatewayConnection>>
}

function record(value: JsonValue | undefined): JsonObject | undefined {
  return isJsonObject(value) ? value : undefined
}

function requiredString(value: JsonValue | undefined): string {
  if (Object.prototype.toString.call(value) !== "[object String]" || String(value).length === 0) {
    throw new Error("connections_provider_invalid_response")
  }
  return String(value)
}

function requiredHttpsUrl(value: JsonValue | undefined): URL {
  try {
    const url = new URL(requiredString(value))
    if (url.protocol !== "https:") throw new Error("invalid_protocol")
    return url
  } catch {
    throw new Error("connections_provider_invalid_response")
  }
}

export function scopedOwnerId(instanceId: string, ownerId: string): string {
  const bytes = new TextEncoder().encode(JSON.stringify([instanceId, ownerId]))
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return `bob:v1:${btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "")}`
}

export function createNangoProvider(options: {
  readonly apiUrl: string
  readonly secretKey: string
  readonly integrations: Readonly<Record<ConnectionProvider, string>>
  readonly fetch?: typeof fetch
  readonly timeoutMs?: number
}): ConnectionsProvider {
  const request = options.fetch ?? fetch
  const baseUrl = new URL(options.apiUrl)
  if (baseUrl.protocol !== "https:" && baseUrl.hostname !== "localhost") {
    throw new Error("Nango URL must use HTTPS")
  }
  const timeoutMs = options.timeoutMs ?? 10_000
  const providerByIntegration = new Map(
    Object.entries(options.integrations).map(([provider, integration]) => [integration, provider])
  )

  async function call(path: string, init?: RequestInit): Promise<JsonValue | undefined> {
    let response: Response
    try {
      const headers = new Headers(init?.headers)
      headers.set("accept", "application/json")
      headers.set("authorization", `Bearer ${options.secretKey}`)
      if (init?.body !== undefined) headers.set("content-type", "application/json")
      response = await request(new URL(path, baseUrl), {
        ...init,
        headers,
        signal: AbortSignal.timeout(timeoutMs)
      })
    } catch {
      throw new Error("connections_provider_unavailable")
    }
    if (!response.ok) throw new Error("connections_provider_failed")
    if (response.status === 204) return undefined
    try {
      return await response.json()
    } catch {
      throw new Error("connections_provider_invalid_response")
    }
  }

  return {
    async createSession(input) {
      const ownerReference = scopedOwnerId(input.instanceId, input.ownerId)
      const response = record(
        await call("/connect/sessions", {
          method: "POST",
          body: JSON.stringify({
            tags: { end_user_id: ownerReference },
            allowed_integrations: [options.integrations[input.provider]]
          })
        })
      )
      const data = record(response?.data)
      if (data === undefined) throw new Error("connections_provider_invalid_response")
      const connectUrl = requiredHttpsUrl(data.connect_link)
      connectUrl.searchParams.set("apiURL", baseUrl.toString().replace(/\/$/u, ""))
      return {
        connectUrl: connectUrl.toString(),
        expiresAt: requiredString(data.expires_at)
      }
    },

    async list(input) {
      const ownerReference = scopedOwnerId(input.instanceId, input.ownerId)
      const query = new URLSearchParams({ limit: "100" })
      query.set("tags[end_user_id]", ownerReference)
      const response = record(await call(`/connections?${query.toString()}`))
      const connections = response?.connections
      if (!Array.isArray(connections)) throw new Error("connections_provider_invalid_response")
      return connections.flatMap((value): ReadonlyArray<GatewayConnection> => {
        const connection = record(value)
        if (connection === undefined) return []
        const tags = record(connection.tags)
        if (tags?.end_user_id !== ownerReference) return []
        const integration = requiredString(connection.provider_config_key)
        const provider = providerByIntegration.get(integration)
        if (provider !== "google_calendar" && provider !== "microsoft_calendar") return []
        return [
          {
            provider,
            connectionId: requiredString(connection.connection_id),
            createdAt: requiredString(connection.created_at ?? connection.created),
            healthy: !Array.isArray(connection.errors) || connection.errors.length === 0
          }
        ]
      })
    }
  }
}
