import { Schema } from "effect"

const Environment = Schema.Struct({
  PORT: Schema.NumberFromString.pipe(
    Schema.check(Schema.isBetween({ minimum: 1, maximum: 65_535 }))
  ),
  AUTO_ENQUEUE_INBOUND: Schema.Literals(["true", "false"]),
  APPLICATION_STORAGE_URL: Schema.URLFromString,
  JOB_QUEUE_URL: Schema.URLFromString,
  OBJECT_STORAGE_DIRECTORY: Schema.String.check(Schema.isMinLength(1)),
  ASSETS_DIRECTORY: Schema.String.check(Schema.isMinLength(1)),
  OWNER_ID: Schema.String.check(Schema.isUUID()),
  OWNER_TIME_ZONE: Schema.String.check(Schema.isMinLength(1)),
  DATA_KEK_ACTIVE_VERSION: Schema.String,
  DATA_KEK_KEYRING_JSON: Schema.String,
  DATA_LOOKUP_KEY: Schema.String.check(Schema.isMinLength(40)),
  INGRESS_CALLER_SECRET: Schema.String.check(Schema.isMinLength(32)),
  EGRESS_CALLER_SECRET: Schema.String.check(Schema.isMinLength(32)),
  AGENT_CALLER_SECRET: Schema.String.check(Schema.isMinLength(32)),
  AGENT_URL: Schema.URLFromString,
  CHANNEL_EGRESS_URL: Schema.URLFromString,
  BOB_MODEL: Schema.String.check(Schema.isMinLength(1)),
  BOB_RUN_TOKEN_BUDGET: Schema.NumberFromString,
  BOB_DAILY_TOKEN_BUDGET: Schema.NumberFromString,
  SCHEDULER_INTERVAL_MS: Schema.NumberFromString.pipe(Schema.check(Schema.isGreaterThan(0)))
})

export function readCoreRuntimeConfiguration(environment: NodeJS.ProcessEnv) {
  const value = Schema.decodeUnknownSync(Environment)({
    ...environment,
    AUTO_ENQUEUE_INBOUND: environment.AUTO_ENQUEUE_INBOUND ?? "false",
    ASSETS_DIRECTORY: environment.ASSETS_DIRECTORY ?? "/app/ui",
    SCHEDULER_INTERVAL_MS: environment.SCHEDULER_INTERVAL_MS ?? "60000"
  })
  return {
    ...value,
    PORT: value.PORT,
    APPLICATION_STORAGE_URL: value.APPLICATION_STORAGE_URL.toString(),
    JOB_QUEUE_URL: value.JOB_QUEUE_URL.toString(),
    AGENT_URL: value.AGENT_URL.toString().replace(/\/$/u, ""),
    CHANNEL_EGRESS_URL: value.CHANNEL_EGRESS_URL.toString().replace(/\/$/u, "")
  }
}

export type CoreRuntimeConfiguration = ReturnType<typeof readCoreRuntimeConfiguration>
