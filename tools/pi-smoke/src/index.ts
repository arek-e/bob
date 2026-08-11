import { AgentRunResult } from "@bob/contracts/agent"
import { AdminStatus } from "@bob/contracts/ui"
import { Schema } from "effect"

import { ENV } from "./environment.generated.ts"

const runHeaders = {
  "CF-Access-Client-Id": ENV.AGENT_ACCESS_CLIENT_ID,
  "CF-Access-Client-Secret": ENV.AGENT_ACCESS_CLIENT_SECRET,
  "content-type": "application/json"
}
const adminHeaders = {
  "CF-Access-Client-Id": ENV.AGENT_ADMIN_ACCESS_CLIENT_ID,
  "CF-Access-Client-Secret": ENV.AGENT_ADMIN_ACCESS_CLIENT_SECRET,
  "content-type": "application/json"
}

const statusResponse = await fetch(`${ENV.AGENT_ADMIN_URL}/v1/admin/auth/status`, {
  headers: adminHeaders
})
if (!statusResponse.ok) throw new Error(`Agent status failed: ${statusResponse.status}`)
const status = Schema.decodeUnknownSync(AdminStatus)(await statusResponse.json())
if (!status.configured) throw new Error("Pi openai-codex credential is not configured")

const report: Record<string, unknown> = {
  authentication: "configured",
  provider: status.provider
}

if (process.argv.includes("--completion")) {
  const runId = crypto.randomUUID()
  const correlationId = crypto.randomUUID()
  const response = await fetch(`${ENV.AGENT_URL}/v1/run`, {
    method: "POST",
    headers: runHeaders,
    body: JSON.stringify({
      protocolVersion: 1,
      runId,
      ownerId: crypto.randomUUID(),
      correlationId,
      localTime: new Date().toISOString(),
      timeZone: "Europe/Stockholm",
      userText: "This is an approved production smoke check. Reply only READY.",
      contextItems: [],
      allowedTools: [],
      limits: {
        maxTurns: 1,
        maxToolCalls: 0,
        maxDurationMs: 30_000,
        maxResponseCharacters: 100
      }
    })
  })
  if (!response.ok) throw new Error(`Agent completion failed: ${response.status}`)
  const result = Schema.decodeUnknownSync(AgentRunResult)(await response.json())
  if (result.status !== "completed") {
    throw new Error(`Agent completion returned ${result.status}:${result.errorCode ?? "unknown"}`)
  }
  report.completion = result.status
  report.model = result.model
  report.durationMs = result.durationMs
}

console.log(JSON.stringify(report))
