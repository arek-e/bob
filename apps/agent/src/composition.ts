import type { Telemetry } from "@bob/observability/effect"

import { nodeTelemetryLayer } from "@bob/observability/node"
import { createBobPiAgent, type BobPiAgent } from "@bob/pi-agent"
import { OpenBaoCredentialStore } from "@bob/pi-agent/auth"
import { Layer, ManagedRuntime } from "effect"
import { readFile } from "node:fs/promises"

import { AccessVerifier, accessVerifierLayer, createAccessVerifier } from "./access.ts"
import { readAgentConfiguration, type AgentConfiguration } from "./configuration.ts"
import { CoreToolClient, coreToolClientLayer, createCoreToolClient } from "./core-tools.ts"

export interface AgentComposition {
  readonly config: AgentConfiguration
  readonly runtime: ManagedRuntime.ManagedRuntime<
    AccessVerifier | CoreToolClient | Telemetry,
    never
  >
  readonly services: {
    readonly access: AccessVerifier
    readonly agent: BobPiAgent
    readonly coreTools: CoreToolClient
  }
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
    executeTool: coreTools.execute,
    executeToolEffect: coreTools.executeEffect
  })
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      accessVerifierLayer(access),
      coreToolClientLayer(coreTools),
      nodeTelemetryLayer({
        endpoint: config.otlpEndpoint,
        serviceName: "bob-agent",
        serviceVersion: config.releaseSha,
        deploymentEnvironment: "prod"
      })
    )
  )
  return {
    config,
    runtime,
    services: { access, agent, coreTools }
  }
}
