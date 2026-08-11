import { readFile } from "node:fs/promises"

import { Effect, Layer } from "effect"
import { createBobPiAgent, type BobPiAgent } from "@bob/pi-agent"
import { OpenBaoCredentialStore } from "@bob/pi-agent/auth"
import { nodeEventSink } from "@bob/observability/node"

import { AccessVerifier, accessVerifierLayer, createAccessVerifier } from "./access.ts"
import { readAgentConfiguration, type AgentConfiguration } from "./configuration.ts"
import { CoreToolClient, coreToolClientLayer, createCoreToolClient } from "./core-tools.ts"

export interface AgentComposition {
  readonly config: AgentConfiguration
  readonly services: {
    readonly access: AccessVerifier
    readonly agent: BobPiAgent
    readonly coreTools: CoreToolClient
    readonly events: ReturnType<typeof nodeEventSink>
  }
  readonly layer: Layer.Layer<never>
}

export function composeAgent(environment: NodeJS.ProcessEnv): AgentComposition {
  const config = readAgentConfiguration(environment)
  const access = createAccessVerifier({
    teamDomain: config.accessTeamDomain,
    runAudience: config.runAccessAudience,
    runSubject: config.runAccessSubject,
    adminAudience: config.adminAccessAudience,
    adminSubject: config.adminAccessSubject
  })
  const coreTools = createCoreToolClient({
    coreUrl: config.coreUrl,
    accessClientId: config.coreAccessClientId,
    accessClientSecret: config.coreAccessClientSecret
  })
  const credentials = new OpenBaoCredentialStore({
    address: config.baoAddress,
    kubernetesRole: config.baoKubernetesRole,
    getKubernetesJwt: async (signal) => {
      if (signal?.aborted === true) throw signal.reason
      return (await readFile(config.baoKubernetesJwtPath, "utf8")).trim()
    }
  })
  const agent = createBobPiAgent({
    credentials,
    provider: config.provider,
    model: config.model,
    allowedModels: config.allowedModels,
    executeTool: coreTools.execute
  })
  const events = nodeEventSink()
  const layer = Layer.mergeAll(accessVerifierLayer(access), coreToolClientLayer(coreTools))
  const services = Effect.runSync(
    Effect.gen(function* () {
      return {
        access: yield* AccessVerifier,
        agent,
        coreTools: yield* CoreToolClient,
        events
      }
    }).pipe(Effect.provide(layer))
  )
  return {
    config,
    services,
    layer
  }
}
