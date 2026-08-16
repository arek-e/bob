import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"

const repository = fileURLToPath(new URL("..", import.meta.url))
const project = process.env.BOB_COMPOSE_SMOKE_PROJECT ?? `bob-runtime-proof-${Date.now()}`
const composeArguments = [
  "compose",
  "-p",
  project,
  "-f",
  "infra/compose/compose.yaml",
  "-f",
  "infra/compose/compose.smoke.yaml"
]
const environment = {
  ...process.env,
  POSTGRES_PASSWORD: "bob-compose-test-password",
  AGENT_CALLER_SECRET: "a".repeat(32),
  BOB_MODEL: "compose-smoke",
  DATA_KEK_ACTIVE_VERSION: "1",
  DATA_KEK_KEYRING_JSON: '{"1":"BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc"}',
  DATA_LOOKUP_KEY: "CAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg",
  EGRESS_CALLER_SECRET: "e".repeat(32),
  INGRESS_CALLER_SECRET: "i".repeat(32),
  OWNER_ID: "018e6f65-4d55-7a1b-8df4-4ee15ea1db91",
  ACCESS_TEAM_DOMAIN: "compose.cloudflareaccess.com",
  ADMIN_ACCESS_AUDIENCE: "admin",
  ADMIN_ACCESS_SUBJECT: "admin",
  BAO_ADDR: "http://openbao.invalid",
  BAO_APPROLE_ROLE_ID: "role",
  BAO_APPROLE_SECRET_ID: "secret",
  BOB_ALLOWED_MODELS: "compose-smoke",
  BOB_RELEASE_SHA: "0".repeat(40),
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://observer:4318",
  RUN_ACCESS_AUDIENCE: "run",
  RUN_ACCESS_SUBJECT: "bob-compose-core",
  SENDBLUE_ACCOUNT_ID: "compose-account",
  SENDBLUE_ALLOWED_USER_NUMBER: "+46700000001",
  SENDBLUE_API_KEY_ID: "compose-key",
  SENDBLUE_API_SECRET_KEY: "compose-secret",
  SENDBLUE_FROM_NUMBER: "+46700000002",
  SENDBLUE_LINE_ID: "compose-line",
  SENDBLUE_STATUS_CALLBACK_URL: "http://channel:8786/webhooks/outbound",
  SENDBLUE_WEBHOOK_SIGNING_SECRET: "s".repeat(32)
}

function docker(...arguments_) {
  return execFileSync("docker", [...composeArguments, ...arguments_], {
    cwd: repository,
    env: environment,
    encoding: "utf8",
    stdio: arguments_[0] === "logs" ? "inherit" : undefined
  })
}

async function waitForDelivery(outboxText) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const response = await fetch("http://127.0.0.1:18790/deliveries")
    if (response.ok) {
      const result = await response.json()
      if (result.deliveries?.some((delivery) => delivery.text === outboxText)) return
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error("Channel Runtime did not deliver the reply")
}

let failure
try {
  process.stdout.write(docker("up", "--detach", "--build", "--wait"))
  const health = await fetch("http://127.0.0.1:18789/health")
  if (!health.ok) throw new Error("Core Runtime health check failed")
  const ui = await fetch("http://127.0.0.1:18789/")
  if (!ui.ok || !(await ui.text()).includes("<!DOCTYPE html>")) {
    throw new Error("Core Runtime static UI check failed")
  }

  const eventId = randomUUID()
  const correlationId = randomUUID()
  const accepted = await fetch("http://127.0.0.1:18789/internal/inbound", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-bob-caller-token": environment.INGRESS_CALLER_SECRET
    },
    body: JSON.stringify({
      id: eventId,
      accountId: "compose-account",
      lineId: "compose-line",
      messageHandle: `compose-${eventId}`,
      senderE164: "+46700000001",
      destinationE164: "+46700000002",
      text: "Verify the portable runtime.",
      service: "imessage",
      isGroup: false,
      providerOptedOut: false,
      receivedAt: new Date().toISOString(),
      correlationId
    })
  })
  if (!accepted.ok) throw new Error(`Inbound request failed with ${accepted.status}`)
  await waitForDelivery("Compose runtime is working.")
  const completed = docker(
    "exec",
    "-T",
    "application-storage",
    "psql",
    "-U",
    "bob",
    "-d",
    "bob",
    "-Atc",
    "select count(*) from agent_runs where status = 'completed';"
  ).trim()
  if (Number(completed) < 1) throw new Error("Agent Runtime run did not complete")
  console.log(
    "Portable runtime completed Core Runtime, Agent Runtime, Channel Runtime, Application Storage, Job Queue, Object Storage, UI, and delivery checks."
  )
} catch (error) {
  failure = error
  try {
    docker("logs", "--no-color", "--tail", "200")
  } catch {}
}
try {
  process.stdout.write(docker("stop"))
} catch (error) {
  failure ??= error
}
if (failure !== undefined) throw failure
