import { Schema } from "effect"

const Environment = Schema.Struct({
  PORT: Schema.NumberFromString.pipe(
    Schema.check(Schema.isBetween({ minimum: 1, maximum: 65_535 }))
  ),
  BAO_ADDR: Schema.URLFromString,
  BAO_AUTH_METHOD: Schema.Literals(["kubernetes", "approle"]),
  BAO_KUBERNETES_ROLE: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1))),
  BAO_KUBERNETES_JWT_PATH: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1))),
  BAO_APPROLE_ROLE_ID: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1))),
  BAO_APPROLE_SECRET_ID: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1))),
  BAO_APPROLE_SECRET_ID_PATH: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1))),
  BOB_PROVIDER: Schema.Literals(["openai-codex", "openrouter"]),
  BOB_MODEL: Schema.String.check(Schema.isMinLength(1)),
  BOB_ALLOWED_MODELS: Schema.String.check(Schema.isMinLength(1)),
  BOB_RELEASE_SHA: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/)),
  OTEL_EXPORTER_OTLP_ENDPOINT: Schema.URLFromString,
  RUNTIME_SHARED_SECRET: Schema.String.check(Schema.isMinLength(32)),
  CORE_URL: Schema.URLFromString,
  CORE_CALLER_SECRET: Schema.String.check(Schema.isMinLength(32)),
  JOB_QUEUE_URL: Schema.URLFromString,
  AGENT_EXECUTION_POOL_ID: Schema.String.check(
    Schema.isPattern(/^[a-z][a-z0-9-]{0,62}$/),
    Schema.isMaxLength(63)
  ),
  AGENT_MAX_CONCURRENCY: Schema.NumberFromString.pipe(
    Schema.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 256 }))
  )
})

export interface AgentConfiguration {
  readonly port: number
  readonly baoAddress: string
  readonly baoAuthentication:
    | {
        readonly method: "kubernetes"
        readonly role: string
        readonly jwtPath: string
      }
    | {
        readonly method: "approle"
        readonly roleId: string
        readonly secretId: string
        readonly secretIdPath?: never
      }
    | {
        readonly method: "approle"
        readonly roleId: string
        readonly secretId?: never
        readonly secretIdPath: string
      }
  readonly provider: "openai-codex" | "openrouter"
  readonly model: string
  readonly allowedModels: readonly string[]
  readonly releaseSha: string
  readonly otlpEndpoint: string
  readonly runtimeSharedSecret: string
  readonly coreUrl: string
  readonly coreCallerSecret: string
  readonly jobQueueUrl: string
  readonly executionPoolId: string
  readonly maximumConcurrency: number
}

export function readAgentConfiguration(environment: NodeJS.ProcessEnv): AgentConfiguration {
  const decoded = Schema.decodeUnknownSync(Environment)(environment)
  const allowedModels = decoded.BOB_ALLOWED_MODELS.split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
  if (allowedModels.length === 0) throw new Error("BOB_ALLOWED_MODELS must contain one model")
  const baoAuthentication =
    decoded.BAO_AUTH_METHOD === "kubernetes"
      ? {
          method: "kubernetes" as const,
          role: requireValue("BAO_KUBERNETES_ROLE", decoded.BAO_KUBERNETES_ROLE),
          jwtPath: requireValue("BAO_KUBERNETES_JWT_PATH", decoded.BAO_KUBERNETES_JWT_PATH)
        }
      : readAppRoleAuthentication(decoded)
  return {
    port: decoded.PORT,
    baoAddress: decoded.BAO_ADDR.toString().replace(/\/$/, ""),
    baoAuthentication,
    provider: decoded.BOB_PROVIDER,
    model: decoded.BOB_MODEL,
    allowedModels,
    releaseSha: decoded.BOB_RELEASE_SHA,
    otlpEndpoint: decoded.OTEL_EXPORTER_OTLP_ENDPOINT.toString().replace(/\/$/, ""),
    runtimeSharedSecret: decoded.RUNTIME_SHARED_SECRET,
    coreUrl: decoded.CORE_URL.toString().replace(/\/$/, ""),
    coreCallerSecret: decoded.CORE_CALLER_SECRET,
    jobQueueUrl: decoded.JOB_QUEUE_URL.toString(),
    executionPoolId: decoded.AGENT_EXECUTION_POOL_ID,
    maximumConcurrency: decoded.AGENT_MAX_CONCURRENCY
  }
}

function readAppRoleAuthentication(
  decoded: typeof Environment.Type
): Extract<AgentConfiguration["baoAuthentication"], { readonly method: "approle" }> {
  const roleId = requireValue("BAO_APPROLE_ROLE_ID", decoded.BAO_APPROLE_ROLE_ID)
  if (decoded.BAO_APPROLE_SECRET_ID !== undefined) {
    return { method: "approle", roleId, secretId: decoded.BAO_APPROLE_SECRET_ID }
  }
  return {
    method: "approle",
    roleId,
    secretIdPath: requireValue(
      "BAO_APPROLE_SECRET_ID or BAO_APPROLE_SECRET_ID_PATH",
      decoded.BAO_APPROLE_SECRET_ID_PATH
    )
  }
}

function requireValue(name: string, value: string | undefined): string {
  if (value === undefined) throw new Error(`${name} is required for the selected BAO_AUTH_METHOD`)
  return value
}
