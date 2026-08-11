export interface NangoConnection {
  readonly connectionId: string
  readonly integrationId: string
  readonly createdAt: string
  readonly tags: Readonly<Record<string, string>>
  readonly healthy: boolean
}

export interface NangoConnectSession {
  readonly token: string
  readonly connectUrl: string
  readonly expiresAt: string
}

export interface NangoClient {
  createConnectSession(input: {
    readonly ownerId: string
    readonly integrationId: string
  }): Promise<NangoConnectSession>
  listConnections(ownerId: string): Promise<readonly NangoConnection[]>
}

interface NangoClientOptions {
  readonly apiUrl: string
  readonly secretKey: string
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
    throw new Error(`Nango returned an invalid ${field}`)
  }
  return value
}

function stringRecord(value: unknown): Readonly<Record<string, string>> {
  const input = record(value)
  if (input === undefined) return {}
  return Object.fromEntries(
    Object.entries(input).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  )
}

export function makeNangoClient(options: NangoClientOptions): NangoClient {
  const request = options.fetch ?? fetch
  const baseUrl = new URL(options.apiUrl)
  if (baseUrl.protocol !== "https:" && baseUrl.hostname !== "localhost") {
    throw new Error("Nango API URL must use HTTPS")
  }
  const timeoutMs = options.timeoutMs ?? 10_000

  async function call(path: string, init?: RequestInit): Promise<unknown> {
    const response = await request(new URL(path, baseUrl), {
      ...init,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${options.secretKey}`,
        ...(init?.body === undefined ? {} : { "content-type": "application/json" }),
        ...init?.headers
      },
      signal: AbortSignal.timeout(timeoutMs)
    })
    if (!response.ok) throw new Error(`Nango request failed with status ${response.status}`)
    return response.status === 204 ? undefined : response.json()
  }

  return {
    async createConnectSession(input) {
      const response = record(
        await call("/connect/sessions", {
          method: "POST",
          body: JSON.stringify({
            tags: { end_user_id: input.ownerId },
            allowed_integrations: [input.integrationId]
          })
        })
      )
      const data = record(response?.data)
      if (data === undefined) throw new Error("Nango returned an invalid connect session")
      const connectUrl = new URL(requiredString(data.connect_link, "connect link"))
      connectUrl.searchParams.set("apiURL", baseUrl.toString().replace(/\/$/u, ""))
      return {
        token: requiredString(data.token, "connect session token"),
        connectUrl: connectUrl.toString(),
        expiresAt: requiredString(data.expires_at, "connect session expiry")
      }
    },

    async listConnections(ownerId) {
      const query = new URLSearchParams({ limit: "100" })
      query.set("tags[end_user_id]", ownerId)
      const response = record(await call(`/connections?${query.toString()}`))
      const connections = response?.connections
      if (!Array.isArray(connections)) throw new Error("Nango returned an invalid connection list")
      return connections.map((value) => {
        const connection = record(value)
        if (connection === undefined) throw new Error("Nango returned an invalid connection")
        const errors = Array.isArray(connection.errors) ? connection.errors : []
        return {
          connectionId: requiredString(connection.connection_id, "connection ID"),
          integrationId: requiredString(connection.provider_config_key, "integration ID"),
          createdAt: requiredString(connection.created_at ?? connection.created, "connection date"),
          tags: stringRecord(connection.tags),
          healthy: errors.length === 0
        }
      })
    }
  }
}
