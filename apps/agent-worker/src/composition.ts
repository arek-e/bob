import type { Telemetry } from "@bob/observability"

import { piAgentLayer } from "@bob/agent-service/pi"
import { AgentProviderError, AgentToolError, BobAgent } from "@bob/agent-types"
import { coreDeploymentProfile } from "@bob/deployment-profile-types/profiles"
import { nodeTelemetryLayer } from "@bob/observability"
import { Effect, Layer, ManagedRuntime } from "effect"
import { readFile } from "node:fs/promises"

import { AccessVerifier, accessVerifierLayer, createSharedSecretAccessVerifier } from "./access.ts"
import { readAgentConfiguration, type AgentConfiguration } from "./configuration.ts"
import { CoreToolClient, coreToolClientLayer, createCoreToolClient } from "./core-tools.ts"
import { OpenBaoCredentialStore } from "./openbao-credential-store.ts"

export const defaultAgentProfile = coreDeploymentProfile

export interface AgentComposition {
  readonly config: AgentConfiguration
  readonly profile: typeof coreDeploymentProfile
  readonly runtime: ManagedRuntime.ManagedRuntime<
    AccessVerifier | BobAgent | CoreToolClient | Telemetry,
    never
  >
  readonly services: {
    readonly access: AccessVerifier
    readonly coreTools: CoreToolClient
  }
}

export function composeAgent(environment: NodeJS.ProcessEnv): AgentComposition {
  const config = readAgentConfiguration(environment)
  const access = createSharedSecretAccessVerifier(config.runtimeSharedSecret)
  const coreTools = createCoreToolClient({
    catalogue: defaultAgentProfile,
    coreUrl: config.coreUrl,
    callerSecret: config.coreCallerSecret
  })
  const credentials = new OpenBaoCredentialStore({
    address: config.baoAddress,
    ...(config.baoAuthentication.method === "kubernetes"
      ? {
          authMethod: "kubernetes" as const,
          kubernetesRole: config.baoAuthentication.role,
          getKubernetesJwt: readSecretFile(config.baoAuthentication.jwtPath)
        }
      : {
          authMethod: "approle" as const,
          appRoleId: config.baoAuthentication.roleId,
          getAppRoleSecretId:
            config.baoAuthentication.secretId === undefined
              ? readSecretFile(config.baoAuthentication.secretIdPath)
              : readSecretValue(config.baoAuthentication.secretId)
        })
  })
  const agentLayer = piAgentLayer({
    catalogue: defaultAgentProfile,
    credentials,
    provider: config.provider,
    model: config.model,
    allowedModels: config.allowedModels,
    executeTool: (command) =>
      coreTools
        .execute(command)
        .pipe(
          Effect.mapError(
            (cause) => new AgentToolError({ message: "Core Tool execution failed", cause })
          )
        ),
    loadAttachment: (runId, attachment) =>
      coreTools.loadAttachment(runId, attachment).pipe(
        Effect.mapError(
          (cause) =>
            new AgentProviderError({
              code: "provider",
              message: "Core attachment load failed",
              cause
            })
        )
      )
  })
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      accessVerifierLayer(access),
      coreToolClientLayer(coreTools),
      agentLayer.pipe(Layer.orDie),
      nodeTelemetryLayer({
        endpoint: config.otlpEndpoint,
        serviceName: "bob-agent-worker",
        serviceVersion: config.releaseSha,
        deploymentEnvironment: "prod"
      })
    )
  )
  return {
    config,
    profile: defaultAgentProfile,
    runtime,
    services: { access, coreTools }
  }
}

function readSecretValue(value: string): (signal?: AbortSignal) => Promise<string> {
  return async (signal) => {
    if (signal?.aborted === true) throw signal.reason
    return value
  }
}

function readSecretFile(path: string): (signal?: AbortSignal) => Promise<string> {
  return async (signal) => {
    if (signal?.aborted === true) throw signal.reason
    const value = (await readFile(path, "utf8")).trim()
    if (value.length === 0) throw new Error(`OpenBao credential file is empty: ${path}`)
    return value
  }
}
