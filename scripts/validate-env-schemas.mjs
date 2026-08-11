import { spawnSync } from "node:child_process"

const paths = [
  "apps/core-worker",
  "apps/sendblue-ingress",
  "apps/sendblue-egress",
  "apps/agent",
  "apps/ui",
  "tools/sendblue-reconcile",
  "tools/pi-smoke",
  "infra/cloudflare"
]

const safeValidationEnvironment = {
  ...process.env,
  BAO_ADDR: "https://openbao.fixture.invalid",
  BAO_JWT_ROLE: "",
  BAO_DEPLOY_TOKEN: "",
  ACTIONS_ID_TOKEN_REQUEST_URL: "",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "",
  OWNER_ID: "00000000-0000-4000-8000-000000000001",
  OWNER_ACCESS_EMAIL: "owner@fixture.invalid",
  OWNER_TIME_ZONE: "Europe/Stockholm",
  DATA_KEK_ACTIVE_VERSION: "fixture-v1",
  DATA_KEK_KEYRING_JSON: '{"fixture-v1":"fixture-key"}',
  DATA_LOOKUP_KEY: "fixture-lookup-key",
  CLOUDFLARE_ACCOUNT_ID: "fixture-account-id",
  CLOUDFLARE_ZONE_ID: "fixture-zone-id",
  CLOUDFLARE_API_TOKEN: "fixture-api-token",
  SENDBLUE_ACCOUNT_ID: "fixture-sendblue-account",
  SENDBLUE_LINE_ID: "fixture-sendblue-line",
  SENDBLUE_API_KEY_ID: "fixture-sendblue-key",
  SENDBLUE_API_SECRET_KEY: "fixture-sendblue-secret",
  SENDBLUE_WEBHOOK_SIGNING_SECRET: "fixture-webhook-secret",
  SENDBLUE_FROM_NUMBER: "+15555550100",
  SENDBLUE_ALLOWED_USER_NUMBER: "+15555550101",
  SENDBLUE_ENABLED: "false",
  INGRESS_CALLER_SECRET: "fixture-ingress-caller",
  EGRESS_CALLER_SECRET: "fixture-egress-caller",
  CORE_CALLER_SECRET: "fixture-core-caller",
  CORE_ACCESS_AUDIENCE: "fixture-core-audience",
  AGENT_CALLER_SUBJECT: "fixture-agent-subject",
  AGENT_ACCESS_CLIENT_ID: "fixture-agent-client",
  AGENT_ACCESS_CLIENT_SECRET: "fixture-agent-secret",
  AGENT_ADMIN_ACCESS_CLIENT_ID: "fixture-agent-admin-client",
  AGENT_ADMIN_ACCESS_CLIENT_SECRET: "fixture-agent-admin-secret",
  RUNTIME_CREDENTIAL_HANDOFF_ENABLED: "false",
  ALCHEMY_PRODUCTION_STATE_APPROVED: "true",
  ALCHEMY_TELEMETRY_DISABLED: "true",
  AGENT_ORIGIN_URL: "http://bob-agent.bob.svc.cluster.local:8787",
  BOB_MODEL: "gpt-5.6-luna",
  BOB_PROVIDER: "openai-codex",
  AGENT_URL: "https://agent.example.invalid",
  AGENT_ADMIN_URL: "https://agent-admin.example.invalid",
  UI_BASE_URL: "https://bob.example.invalid",
  SENDBLUE_STATUS_CALLBACK_URL: "https://ingress.example.invalid/webhooks/outbound",
  CORE_URL: "https://core.example.invalid",
  CORE_ACCESS_CLIENT_ID: "schema-validation-client",
  CORE_ACCESS_CLIENT_SECRET: "schema-validation-value",
  RUN_ACCESS_AUDIENCE: "schema-validation-run-audience",
  RUN_ACCESS_SUBJECT: "schema-validation-run-subject",
  ADMIN_ACCESS_AUDIENCE: "schema-validation-admin-audience",
  ADMIN_ACCESS_SUBJECT: "schema-validation-admin-subject",
  PUBLIC_API_BASE_URL: "same-origin",
  SENDBLUE_RECEIVE_WEBHOOK_URL: "https://ingress.example.invalid/webhooks/receive",
  SENDBLUE_OUTBOUND_WEBHOOK_URL: "https://ingress.example.invalid/webhooks/outbound",
  BOB_DOMAIN: "example.invalid",
  ACCESS_TEAM_DOMAIN: "example.cloudflareaccess.com",
  REMINDER_QUIET_HOURS_START: "22:00",
  REMINDER_QUIET_HOURS_END: "07:00",
  REMINDER_DAILY_LIMIT: "4",
  ACCESS_SERVICE_TOKEN_ROTATION_VERSION: "1",
  ACCESS_SERVICE_TOKEN_ROTATE_BY: "2099-01-01T00:00:00.000Z"
}

for (const path of paths) {
  const result = spawnSync(
    "pnpm",
    [
      "exec",
      "varlock",
      "load",
      "--agent",
      "--compact",
      "--skip-cache",
      "--filter=!@sensitive",
      "--path",
      path
    ],
    { env: safeValidationEnvironment, stdio: "inherit" }
  )
  if (result.status !== 0) process.exit(result.status ?? 1)
}
