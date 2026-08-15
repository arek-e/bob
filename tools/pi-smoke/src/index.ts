import { AgentRunResult, type AgentRunRequest } from "@bob/contracts/agent"
import { coreDeploymentProfile } from "@bob/contracts/deployment-profiles/core"
import { AdminStatus } from "@bob/contracts/ui/core"
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

interface SmokeResult {
  id: string
  status: AgentRunResult["status"]
  model: string
  durationMs: number
  toolCalls: number
}

interface SmokeReport {
  authentication: string
  provider: string
  completion?: AgentRunResult["status"]
  model?: string
  durationMs?: number
  cases?: SmokeResult[]
  predeploy?: string
}

const report: SmokeReport = {
  authentication: "configured",
  provider: status.provider
}

interface SmokeCase {
  readonly id: string
  readonly userText: string
  readonly allowedTools: AgentRunRequest["allowedTools"]
  readonly maxTurns: number
  readonly maxToolCalls: number
  readonly maxResponseCharacters: number
  readonly validate?: (result: AgentRunResult) => boolean
}

const structuredCompletion: SmokeCase = {
  id: "structured-completion",
  userText: "Give a brief greeting for this approved smoke check. Follow the required format.",
  allowedTools: [],
  maxTurns: 2,
  maxToolCalls: 0,
  maxResponseCharacters: 100
}

async function runSmokeCase(smokeCase: SmokeCase): Promise<SmokeResult> {
  const runId = crypto.randomUUID()
  const correlationId = crypto.randomUUID()
  const response = await fetch(`${ENV.AGENT_URL}/v1/run`, {
    method: "POST",
    headers: runHeaders,
    body: JSON.stringify({
      protocolVersion: 1,
      deploymentProfileId: coreDeploymentProfile.profileId,
      capabilityCatalogueGeneration: coreDeploymentProfile.generation,
      runId,
      ownerId: crypto.randomUUID(),
      correlationId,
      sourceMessageId: crypto.randomUUID(),
      localTime: new Date().toISOString(),
      timeZone: "Europe/Stockholm",
      locale: "en-SE",
      hourCycle: "h23",
      userText: smokeCase.userText,
      contextItems: [],
      allowedTools: smokeCase.allowedTools,
      limits: {
        maxTurns: smokeCase.maxTurns,
        maxToolCalls: smokeCase.maxToolCalls,
        maxDurationMs: 30_000,
        maxResponseCharacters: smokeCase.maxResponseCharacters
      }
    })
  })
  if (!response.ok) throw new Error(`Agent smoke failed: ${smokeCase.id}:${response.status}`)
  const result = Schema.decodeUnknownSync(AgentRunResult)(await response.json())
  if (result.status !== "completed") {
    throw new Error(
      `Agent smoke returned ${smokeCase.id}:${result.status}:${result.errorCode ?? "unknown"}:tools=${result.toolCalls}`
    )
  }
  if (smokeCase.validate?.(result) === false) {
    throw new Error(`Agent smoke assertion failed: ${smokeCase.id}`)
  }
  return {
    id: smokeCase.id,
    status: result.status,
    model: result.model,
    durationMs: result.durationMs,
    toolCalls: result.toolCalls
  }
}

if (process.argv.includes("--completion")) {
  const completion = await runSmokeCase(structuredCompletion)
  report.completion = completion.status
  report.model = completion.model
  report.durationMs = completion.durationMs
}

if (process.argv.includes("--predeploy")) {
  const cases: SmokeResult[] = []
  report.cases = cases
  for (const smokeCase of [structuredCompletion]) {
    cases.push(await runSmokeCase(smokeCase))
  }
  report.predeploy = "completed"
}

console.log(JSON.stringify(report))
