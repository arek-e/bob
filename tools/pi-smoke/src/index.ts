import { AgentSmokeResult } from "@bob/contracts/agent"
import { AdminStatus } from "@bob/contracts/ui/core"
import { Schema } from "effect"

import { ENV } from "./environment.generated.ts"

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

interface SmokeResult {
  id: string
  status: "completed"
  model: string
  durationMs: number
}

interface SmokeReport {
  authentication: string
  provider: string
  completion?: "completed"
  model?: string
  durationMs?: number
  cases?: SmokeResult[]
  predeploy?: string
}

const report: SmokeReport = {
  authentication: "configured",
  provider: status.provider
}

async function runSmokeCase(): Promise<SmokeResult> {
  const response = await fetch(`${ENV.AGENT_ADMIN_URL}/v1/admin/smoke`, {
    method: "POST",
    headers: adminHeaders
  })
  if (!response.ok) throw new Error(`Agent model smoke failed: ${response.status}`)
  const result = Schema.decodeUnknownSync(AgentSmokeResult)(await response.json())
  if (result.status !== "completed") {
    throw new Error(`Agent model smoke returned ${result.status}:${result.errorCode ?? "unknown"}`)
  }
  return {
    id: "model-completion",
    status: result.status,
    model: result.model,
    durationMs: result.durationMs
  }
}

if (process.argv.includes("--completion")) {
  const completion = await runSmokeCase()
  report.completion = completion.status
  report.model = completion.model
  report.durationMs = completion.durationMs
}

if (process.argv.includes("--predeploy")) {
  const cases: SmokeResult[] = []
  report.cases = cases
  cases.push(await runSmokeCase())
  report.predeploy = "completed"
}

console.log(JSON.stringify(report))
