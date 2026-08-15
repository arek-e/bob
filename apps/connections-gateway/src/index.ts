import type { ConnectionsGatewayBindings } from "./bindings.ts"

import { createConnectionsGateway } from "./http.ts"
import { createInstanceAuthenticator } from "./identity.ts"
import { createNangoProvider } from "./nango.ts"

export default {
  fetch(request: Request, bindings: ConnectionsGatewayBindings): Promise<Response> {
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
    })(request)
  }
} satisfies ExportedHandler<ConnectionsGatewayBindings>
