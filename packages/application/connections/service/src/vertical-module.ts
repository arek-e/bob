import type { PreparedVerticalModule, VerticalModule } from "@bob/deployment-profile-types/runtime"

import { connectionsCapability } from "@bob/connections-types/capability"
import { createRuntimeModules } from "@bob/core-types/runtime-module"
import { Schema } from "effect"

import { createConnectionsGatewayClient } from "./gateway.ts"
import { createConnectionOwnerRoutes } from "./owner-routes.ts"
import { createConnectionStore } from "./store.ts"
import { createConnectionsToolAdapter } from "./tool-adapter.ts"

const Configuration = Schema.Struct({
  CONNECTIONS_GATEWAY_URL: Schema.String.check(Schema.isMinLength(1)),
  CONNECTIONS_GATEWAY_CALLER_SECRET: Schema.String.check(Schema.isMinLength(32))
})

export const connectionsVerticalModule: VerticalModule = {
  id: connectionsCapability.id,
  capability: connectionsCapability,
  prepare(context): PreparedVerticalModule {
    const config = Schema.decodeUnknownSync(Configuration)(context.bindings)
    const gateway = createConnectionsGatewayClient({
      url: config.CONNECTIONS_GATEWAY_URL,
      callerSecret: config.CONNECTIONS_GATEWAY_CALLER_SECRET
    })
    const connections = createConnectionStore(context.database, gateway, {})

    return {
      id: connectionsCapability.id,
      capability: connectionsCapability,
      evidenceSources: [],
      legacyArtifactReaders: [],
      deliveryTargets: [],
      runtimeModules: createRuntimeModules({
        ownerRoutes: [createConnectionOwnerRoutes(connections)]
      }),
      toolAdapters: [createConnectionsToolAdapter(connections)]
    }
  }
}
