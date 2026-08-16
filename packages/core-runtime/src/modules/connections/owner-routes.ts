import { ConnectionProvider } from "@bob/contracts/capabilities/connections"
import { Schema } from "effect"

import type { OwnerRouteModule } from "../runtime/module.ts"
import type { ConnectionStore } from "./store.ts"

export function makeConnectionOwnerRoutes(connections: ConnectionStore): OwnerRouteModule {
  return {
    id: "connection-owner-routes",
    async handle(context) {
      const { request, url, ownerId } = context
      if (request.method === "GET" && url.pathname === "/api/connections") {
        return { body: { connections: await connections.list(ownerId) } }
      }
      const session = url.pathname.match(/^\/api\/connections\/([^/]+)\/session$/)
      if (request.method !== "POST" || session === null) return undefined
      const provider = Schema.decodeUnknownSync(ConnectionProvider)(decodeURIComponent(session[1]!))
      return { body: await connections.createSession(ownerId, provider), status: 201 }
    }
  }
}
