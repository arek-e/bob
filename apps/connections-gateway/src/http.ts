import type { InstanceAuthenticator } from "./identity.ts"
import type { ConnectionProvider, ConnectionsProvider } from "./nango.ts"

import { requiredJsonObject, requiredText, type JsonObject } from "./json.ts"

const MAX_BODY_BYTES = 16 * 1024

function json<Body>(body: Body, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" }
  })
}

async function readBody(request: Request): Promise<JsonObject> {
  const text = await request.text()
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) throw new Error("body_too_large")
  return requiredJsonObject(JSON.parse(text))
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
        const providerValue = requiredText(body.provider)
        if (providerValue !== "google_calendar" && providerValue !== "microsoft_calendar")
          throw new Error("invalid_request")
        const provider: ConnectionProvider =
          providerValue === "google_calendar" ? "google_calendar" : "microsoft_calendar"
        return json(
          await options.connections.createSession({
            instanceId: identity.instanceId,
            ownerId,
            provider
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
