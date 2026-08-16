import type { InstanceAuthenticator } from "./identity.ts"
import type { ConnectionProvider, ConnectionsProvider } from "./nango.ts"

import { GatewayFailure, gatewayFailure, type GatewayFailureCode } from "./failure.ts"
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
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    throw gatewayFailure("body_too_large")
  }
  try {
    return requiredJsonObject(JSON.parse(text))
  } catch (error) {
    if (error instanceof GatewayFailure) throw error
    throw gatewayFailure("invalid_request")
  }
}

const failureStatus = {
  access_denied: 401,
  invalid_request: 400,
  body_too_large: 413,
  provider_unavailable: 502,
  internal_error: 500
} satisfies Readonly<Record<GatewayFailureCode, number>>

function failureResponse(failure: GatewayFailure): Response {
  return json({ code: failure.code }, failureStatus[failure.code])
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
          throw gatewayFailure("invalid_request")
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
      return failureResponse(
        error instanceof GatewayFailure ? error : gatewayFailure("internal_error")
      )
    }
  }
}
