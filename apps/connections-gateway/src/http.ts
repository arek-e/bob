import type { InstanceAuthenticator } from "./identity.ts"
import type { ConnectionProvider, ConnectionsProvider } from "./nango.ts"

const MAX_BODY_BYTES = 16 * 1024
const providers = new Set<ConnectionProvider>(["google_calendar", "microsoft_calendar"])

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" }
  })
}

function requiredText(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 200) {
    throw new Error("invalid_request")
  }
  return value
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text()
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) throw new Error("body_too_large")
  const value: unknown = JSON.parse(text)
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid_request")
  }
  return value as Record<string, unknown>
}

export function createConnectionsGateway(options: {
  readonly authenticator: InstanceAuthenticator
  readonly connections: ConnectionsProvider
}) {
  return async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === "GET" && url.pathname === "/healthz") {
      return json({ status: "ok" })
    }
    try {
      const identity = await options.authenticator.authenticate(request)
      if (request.method === "POST" && url.pathname === "/v1/connect-sessions") {
        const body = await readBody(request)
        const ownerId = requiredText(body.ownerId)
        const provider = requiredText(body.provider)
        if (!providers.has(provider as ConnectionProvider)) throw new Error("invalid_request")
        return json(
          await options.connections.createSession({
            instanceId: identity.instanceId,
            ownerId,
            provider: provider as ConnectionProvider
          }),
          201
        )
      }
      if (request.method === "GET" && url.pathname === "/v1/connections") {
        const ownerId = requiredText(url.searchParams.get("ownerId"))
        return json({
          connections: await options.connections.list({
            instanceId: identity.instanceId,
            ownerId
          })
        })
      }
      return json({ code: "not_found" }, 404)
    } catch (error) {
      const code = error instanceof Error ? error.message : "internal_error"
      if (code === "access_denied") return json({ code }, 401)
      if (code === "invalid_request" || error instanceof SyntaxError) {
        return json({ code: "invalid_request" }, 400)
      }
      if (code === "body_too_large") return json({ code }, 413)
      if (code.startsWith("connections_provider_")) return json({ code }, 502)
      return json({ code: "internal_error" }, 500)
    }
  }
}
