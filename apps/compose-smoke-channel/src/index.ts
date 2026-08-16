import { Worker, type ConnectionOptions, type Job } from "bullmq"
import { createServer } from "node:http"

const coreUrl = process.env.CORE_URL ?? "http://core:8788"
const jobQueueUrl = new URL(process.env.JOB_QUEUE_URL ?? "redis://job-queue:6379")
const jobQueueConnection: ConnectionOptions = {
  host: jobQueueUrl.hostname,
  port: Number(jobQueueUrl.port || "6379")
}
if (jobQueueUrl.password.length > 0) {
  jobQueueConnection.password = decodeURIComponent(jobQueueUrl.password)
}
if (jobQueueUrl.protocol === "rediss:") jobQueueConnection.tls = {}
const callerSecret = process.env.EGRESS_CALLER_SECRET
if (callerSecret === undefined || callerSecret.length < 32) {
  throw new Error("EGRESS_CALLER_SECRET is required")
}

const deliveries: Array<{ readonly outboxId: string; readonly text: string }> = []
interface OutboundPayload {
  readonly outboxId: string
  readonly correlationId?: string
}
interface ClaimedReply {
  readonly outboxId: string
  readonly attemptId: string
  readonly correlationId: string
  readonly smsSafeText: string
}
const headers = (correlationId: string) => ({
  "content-type": "application/json",
  "x-bob-caller-token": callerSecret,
  "x-bob-correlation-id": correlationId
})

const worker = new Worker<OutboundPayload>(
  "bob-outbound",
  async (job: Job<OutboundPayload>) => {
    const payload = job.data
    const correlationId = payload.correlationId ?? payload.outboxId
    const claimed = await fetch(`${coreUrl}/internal/outbox/${payload.outboxId}/claim`, {
      method: "POST",
      headers: headers(correlationId)
    })
    if (claimed.status === 409) return
    if (!claimed.ok) throw new Error(`claim_failed_${claimed.status}`)
    // SAFETY: Core returned an authenticated successful OutboxClaim response.
    const claim = (await claimed.json()) as ClaimedReply
    deliveries.push({ outboxId: claim.outboxId, text: claim.smsSafeText })
    const recorded = await fetch(`${coreUrl}/internal/outbox/${claim.outboxId}/result`, {
      method: "POST",
      headers: headers(claim.correlationId),
      body: JSON.stringify({
        outboxId: claim.outboxId,
        attemptId: claim.attemptId,
        correlationId: claim.correlationId,
        state: "accepted",
        providerMessageHandle: `compose-${claim.outboxId}`,
        occurredAt: new Date().toISOString()
      })
    })
    if (!recorded.ok) throw new Error(`result_failed_${recorded.status}`)
  },
  {
    connection: jobQueueConnection,
    prefix: "bob"
  }
)

const server = createServer((request, response) => {
  response.setHeader("content-type", "application/json")
  if (request.method === "GET" && request.url === "/health") {
    response.end(JSON.stringify({ healthy: worker.isRunning() }))
    return
  }
  if (request.method === "GET" && request.url === "/deliveries") {
    response.end(JSON.stringify({ deliveries }))
    return
  }
  response.writeHead(404).end('{"code":"not_found"}')
})
server.listen(8786, "0.0.0.0")

async function shutdown(): Promise<void> {
  server.close()
  await worker.close()
}
process.once("SIGTERM", () => void shutdown())
process.once("SIGINT", () => void shutdown())
