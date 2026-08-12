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
  BAO_APPROLE_SECRET_ID_PATH: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1))),
  BOB_PROVIDER: Schema.Literal("openai-codex"),
  BOB_MODEL: Schema.String.check(Schema.isMinLength(1)),
  BOB_ALLOWED_MODELS: Schema.String.check(Schema.isMinLength(1)),
  BOB_RELEASE_SHA: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/)),
  OTEL_EXPORTER_OTLP_ENDPOINT: Schema.URLFromString,
  CORE_URL: Schema.URLFromString,
  CORE_ACCESS_CLIENT_ID: Schema.String.check(Schema.isMinLength(1)),
  CORE_ACCESS_CLIENT_SECRET: Schema.String.check(Schema.isMinLength(1)),
  ACCESS_TEAM_DOMAIN: Schema.String.check(Schema.isPattern(/^[a-z0-9-]+\.cloudflareaccess\.com$/)),
  RUN_ACCESS_AUDIENCE: Schema.String.check(Schema.isMinLength(1)),
  RUN_ACCESS_SUBJECT: Schema.String.check(Schema.isMinLength(1)),
  ADMIN_ACCESS_AUDIENCE: Schema.String.check(Schema.isMinLength(1)),
  ADMIN_ACCESS_SUBJECT: Schema.String.check(Schema.isMinLength(1))
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
        readonly secretIdPath: string
      }
  readonly provider: "openai-codex"
  readonly model: string
  readonly allowedModels: readonly string[]
  readonly releaseSha: string
  readonly otlpEndpoint: string
  readonly coreUrl: string
  readonly coreAccessClientId: string
  readonly coreAccessClientSecret: string
  readonly accessTeamDomain: string
  readonly runAccessAudience: string
  readonly runAccessSubject: string
  readonly adminAccessAudience: string
  readonly adminAccessSubject: string
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
      : {
          method: "approle" as const,
          roleId: requireValue("BAO_APPROLE_ROLE_ID", decoded.BAO_APPROLE_ROLE_ID),
          secretIdPath: requireValue(
            "BAO_APPROLE_SECRET_ID_PATH",
            decoded.BAO_APPROLE_SECRET_ID_PATH
          )
        }
  return {
    port: decoded.PORT,
    baoAddress: decoded.BAO_ADDR.toString().replace(/\/$/, ""),
    baoAuthentication,
    provider: decoded.BOB_PROVIDER,
    model: decoded.BOB_MODEL,
    allowedModels,
    releaseSha: decoded.BOB_RELEASE_SHA,
    otlpEndpoint: decoded.OTEL_EXPORTER_OTLP_ENDPOINT.toString().replace(/\/$/, ""),
    coreUrl: decoded.CORE_URL.toString().replace(/\/$/, ""),
    coreAccessClientId: decoded.CORE_ACCESS_CLIENT_ID,
    coreAccessClientSecret: decoded.CORE_ACCESS_CLIENT_SECRET,
    accessTeamDomain: decoded.ACCESS_TEAM_DOMAIN,
    runAccessAudience: decoded.RUN_ACCESS_AUDIENCE,
    runAccessSubject: decoded.RUN_ACCESS_SUBJECT,
    adminAccessAudience: decoded.ADMIN_ACCESS_AUDIENCE,
    adminAccessSubject: decoded.ADMIN_ACCESS_SUBJECT
  }
}

function requireValue(name: string, value: string | undefined): string {
  if (value === undefined) throw new Error(`${name} is required for the selected BAO_AUTH_METHOD`)
  return value
}
