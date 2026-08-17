import type { ConnectionOptions } from "bullmq"

import { AgentRunJob } from "@bob/agent-runs-types/worker-gateway"
import { startBullMqWorkerHost } from "@bob/job-queue-runtime/bullmq-host"
import { decodeJobProcessor, retryJob } from "@bob/job-queue-types"
import { NodeRuntime } from "@effect/platform-node"
import { Effect, Schema } from "effect"
import { createServer } from "node:http"

import { composeAgent } from "./composition.ts"
import { handleAgentHttp } from "./http.ts"
import { AGENT_LISTEN_HOST } from "./listener.ts"
import { createNodeHttpHandler } from "./node-http.ts"
import { makeAgentRunJobProcessor } from "./queue.ts"
import { serveAgent } from "./server.ts"

function redisConnection(urlValue: string): ConnectionOptions {
  const url = new URL(urlValue)
  const password = url.password.length === 0 ? undefined : decodeURIComponent(url.password)
  const connection: ConnectionOptions = {
    host: url.hostname,
    port: Number(url.port || "6379")
  }
  if (password !== undefined) connection.password = password
  if (url.protocol === "rediss:") connection.tls = {}
  return connection
}

const composition = composeAgent(process.env)
const agentRuns = composition.services.agentRuns
if (agentRuns === undefined) throw new Error("Agent Run Gateway is required")
const server = createServer(
  createNodeHttpHandler((request) => handleAgentHttp(request, composition))
)
const workerId = `agent-${process.pid}-${crypto.randomUUID().slice(0, 8)}`
const workers = startBullMqWorkerHost(
  [
    {
      queueName: `bob-agent-runs-${composition.config.executionPoolId}`,
      concurrency: composition.config.maximumConcurrency,
      processor: decodeJobProcessor(
        { decode: (input) => Schema.decodeUnknownSync(AgentRunJob)(input) },
        makeAgentRunJobProcessor({
          composition,
          gateway: agentRuns,
          workerId
        }),
        retryJob(30_000)
      )
    }
  ],
  {
    connection: redisConnection(composition.config.jobQueueUrl),
    prefix: "bob",
    onUnexpectedError(queueName, error) {
      console.error(
        JSON.stringify({ type: "agent_run_processor_failure", queueName, errorName: error.name })
      )
    }
  }
)

const main = Effect.tryPromise(() => workers.ready()).pipe(
  Effect.flatMap(() =>
    serveAgent(server, {
      port: composition.config.port,
      host: AGENT_LISTEN_HOST,
      disposeRuntime: composition.runtime.disposeEffect
    })
  ),
  Effect.ensuring(Effect.promise(() => workers.close()))
)

NodeRuntime.runMain(main)
