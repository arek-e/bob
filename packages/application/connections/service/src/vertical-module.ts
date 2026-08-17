import type { PreparedVerticalModule, VerticalModule } from "@bob/deployment-profile-types/runtime"

import { connectionsCapability } from "@bob/connections-types/capability"
import { makeRuntimeModules } from "@bob/core-types/runtime-module"
import { Schema } from "effect"

import { makeConnectionsGatewayClient } from "./gateway.ts"
import { makeConnectionOwnerRoutes } from "./owner-routes.ts"
import { makeConnectionStore } from "./store.ts"
import { makeConnectionsToolAdapter } from "./tool-adapter.ts"

const Configuration = Schema.Struct({
  CONNECTIONS_GATEWAY_URL: Schema.String.check(Schema.isMinLength(1)),
  CONNECTIONS_GATEWAY_CALLER_SECRET: Schema.String.check(Schema.isMinLength(32))
})

export const connectionsVerticalModule: VerticalModule = {
  id: connectionsCapability.id,
  capability: connectionsCapability,
  prepare(context): PreparedVerticalModule {
    const config = Schema.decodeUnknownSync(Configuration)(context.bindings)
    const gateway = makeConnectionsGatewayClient({
      url: config.CONNECTIONS_GATEWAY_URL,
      callerSecret: config.CONNECTIONS_GATEWAY_CALLER_SECRET
    })
    const connections = makeConnectionStore(context.database, gateway, {})

    return {
      id: connectionsCapability.id,
      capability: connectionsCapability,
      evidenceSources: [],
      legacyArtifactReaders: [],
      deliveryTargets: [],
      runtimeModules: makeRuntimeModules({
        ownerRoutes: [makeConnectionOwnerRoutes(connections)]
      }),
      toolAdapters: [makeConnectionsToolAdapter(connections)]
    }
  }
}
