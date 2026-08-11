import * as Alchemy from "alchemy"

import type { CoercedEnvSchema } from "./src/environment.generated.ts"

import { createBobStack } from "./src/bob-stack.ts"
import { smokeProviders } from "./src/smoke-providers.ts"

const fixtureConfig = {
  CLOUDFLARE_ACCOUNT_ID: "offline-account-fixture",
  CLOUDFLARE_ZONE_ID: "offline-zone-fixture",
  CLOUDFLARE_API_TOKEN: "offline-api-token-fixture",
  CLOUDFLARE_WORKERS_SUBDOMAIN: "offline-workers-fixture",
  CLOUDFLARE_CORE_WORKER_NAME: "offline-core-worker-fixture",
  BOB_DOMAIN: "bob.invalid",
  OWNER_ACCESS_EMAIL: "owner@bob.invalid",
  ACCESS_TEAM_DOMAIN: "bob.cloudflareaccess.invalid",
  AGENT_ORIGIN_URL: "http://bob-agent.bob.svc.cluster.local:8787",
  OWNER_ID: "00000000-0000-4000-8000-000000000001",
  OWNER_TIME_ZONE: "Europe/Stockholm",
  REMINDER_QUIET_HOURS_START: "21:00",
  REMINDER_QUIET_HOURS_END: "08:00",
  REMINDER_DAILY_LIMIT: 6,
  BOB_MODEL: "gpt-5.4-mini",
  BOB_PROVIDER: "openai-codex",
  BOB_RUN_TOKEN_BUDGET: 32_000,
  BOB_DAILY_TOKEN_BUDGET: 250_000,
  DATA_KEK_ACTIVE_VERSION: "fixture-v1",
  DATA_KEK_KEYRING_JSON: '{"fixture-v1":"offline-key-fixture"}',
  DATA_LOOKUP_KEY: "offline-lookup-fixture",
  BETTER_AUTH_SECRET: "offline-better-auth-secret-at-least-32-bytes",
  NANGO_SECRET_KEY: "offline-nango-secret-key-at-least-32-bytes",
  SENDBLUE_ENABLED: false,
  ALCHEMY_PRODUCTION_STATE_APPROVED: true,
  ALCHEMY_TELEMETRY_DISABLED: true,
  RUNTIME_CREDENTIAL_HANDOFF_ENABLED: true,
  ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.actions.invalid/offline-fixture",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "offline-request-fixture",
  ACCESS_SERVICE_TOKEN_ROTATION_VERSION: 1,
  ACCESS_SERVICE_TOKEN_ROTATE_BY: new Date(Date.now() + 2 * 86_400_000).toISOString(),
  BAO_ADDR: "https://openbao.invalid",
  BAO_JWT_ROLE: "offline-handoff-role-fixture"
} satisfies CoercedEnvSchema

export default createBobStack({
  config: fixtureConfig,
  name: "bob-alchemy-compatibility",
  providers: smokeProviders(),
  state: Alchemy.inMemoryState()
})
