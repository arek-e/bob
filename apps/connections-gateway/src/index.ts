import type { ConnectionsGatewayBindings } from "./bindings.ts"

import { createConnectionsGateway } from "./http.ts"
import { createInstanceAuthenticator } from "./identity.ts"
import { createNangoProvider } from "./nango.ts"

type GatewayHandler = ReturnType<typeof createConnectionsGateway>

interface CachedGateway {
  readonly bindings: ConnectionsGatewayBindings
  readonly handle: GatewayHandler
}

function hasSameBindings(
  cached: ConnectionsGatewayBindings,
  current: ConnectionsGatewayBindings
): boolean {
  return (
    cached.DB === current.DB &&
    cached.ACCESS_TEAM_DOMAIN === current.ACCESS_TEAM_DOMAIN &&
    cached.ACCESS_AUDIENCE === current.ACCESS_AUDIENCE &&
    cached.NANGO_API_URL === current.NANGO_API_URL &&
    cached.NANGO_SECRET_KEY === current.NANGO_SECRET_KEY &&
    cached.NANGO_GOOGLE_CALENDAR_INTEGRATION_ID === current.NANGO_GOOGLE_CALENDAR_INTEGRATION_ID &&
    cached.NANGO_MICROSOFT_CALENDAR_INTEGRATION_ID ===
      current.NANGO_MICROSOFT_CALENDAR_INTEGRATION_ID
  )
}

function createHandler(bindings: ConnectionsGatewayBindings): GatewayHandler {
  return createConnectionsGateway({
    authenticator: createInstanceAuthenticator({
      database: bindings.DB,
      teamDomain: bindings.ACCESS_TEAM_DOMAIN,
      audience: bindings.ACCESS_AUDIENCE
    }),
    connections: createNangoProvider({
      apiUrl: bindings.NANGO_API_URL,
      secretKey: bindings.NANGO_SECRET_KEY,
      integrations: {
        google_calendar: bindings.NANGO_GOOGLE_CALENDAR_INTEGRATION_ID,
        microsoft_calendar: bindings.NANGO_MICROSOFT_CALENDAR_INTEGRATION_ID
      }
    })
  })
}

function snapshotBindings(bindings: ConnectionsGatewayBindings): ConnectionsGatewayBindings {
  return { ...bindings }
}

// Cloudflare keeps module state for one isolate. Retain only its current binding tuple.
let cachedGateway: CachedGateway | undefined

export default {
  fetch(request: Request, bindings: ConnectionsGatewayBindings): Promise<Response> {
    if (cachedGateway === undefined || !hasSameBindings(cachedGateway.bindings, bindings)) {
      cachedGateway = {
        bindings: snapshotBindings(bindings),
        handle: createHandler(bindings)
      }
    }
    return cachedGateway.handle(request)
  }
} satisfies ExportedHandler<ConnectionsGatewayBindings>
