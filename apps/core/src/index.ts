import { InboundAcceptance } from "@bob/contracts/channel"
import { OwnerWakeJob } from "@bob/contracts/jobs"
import { makeCoreJobConsumerRoutes } from "@bob/core-runtime/job-processors"
import {
  composeCoreWithRuntime,
  handleScheduled,
  handleHttp,
  makeOwnerWakeJobProcessor,
  makeQueuedOwnerRunCoordinator,
  makeOwnerTurnEngine,
  processConversationTurn,
  type CoreBindings,
  type CoreRuntimeAdapters
} from "@bob/core-runtime/runtime"
import { connectPostgresqlDatabase } from "@bob/db/postgresql"
import { decodeJobProcessor, retryJob } from "@bob/job-queue"
import { makeBullMqJobPublisher } from "@bob/job-queue/bullmq"
import { startBullMqWorkerHost } from "@bob/job-queue/bullmq-host"
import { makeFilesystemPrivateObjectStore } from "@bob/object-store/filesystem"
import { nodeEventSink } from "@bob/observability/node"
import { Queue, type ConnectionOptions } from "bullmq"
import { Schema } from "effect"
import { createServer } from "node:http"

import { readCoreRuntimeConfiguration } from "./configuration.ts"
import { webRequest, writeWebResponse } from "./node-http.ts"
import { makeFilesystemAssetFetcher } from "./static-assets.ts"

const queueNames = {
  inbound: "bob-inbound",
  inboundDeadLetter: "bob-inbound-dead-letter",
  outbound: "bob-outbound",
  outboundDeadLetter: "bob-outbound-dead-letter",
  deliveryResult: "bob-delivery-result",
  deliveryResultDeadLetter: "bob-delivery-result-dead-letter",
  ownerWake: "bob-owner-wake"
} as const

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

function applicationStorageErrorCode(error: Error): string | undefined {
  const decoded = Schema.decodeUnknownOption(
    Schema.Struct({ cause: Schema.Struct({ code: Schema.String }) })
  )(error)
  return decoded._tag === "Some" ? decoded.value.cause.code : undefined
}

function applicationStorageErrorQuery(error: Error): string | undefined {
  const decoded = Schema.decodeUnknownOption(Schema.Struct({ query: Schema.String }))(error)
  return decoded._tag === "Some" ? decoded.value.query.slice(0, 240) : undefined
}

async function main(): Promise<void> {
  const config = readCoreRuntimeConfiguration(process.env)
  const database = connectPostgresqlDatabase(config.APPLICATION_STORAGE_URL)
  await database.migrate()
  const connection = redisConnection(config.JOB_QUEUE_URL)
  const queueOptions = { connection, prefix: "bob" }
  const inboundQueue = new Queue(queueNames.inbound, queueOptions)
  const outboundQueue = new Queue(queueNames.outbound, queueOptions)
  const ownerWakeQueue = new Queue(queueNames.ownerWake, queueOptions)
  const jobQueue = Object.freeze({
    inbound: makeBullMqJobPublisher(inboundQueue, "inbound"),
    outbound: makeBullMqJobPublisher(outboundQueue, "outbound")
  })
  const applicationStorage = database.applicationStorage
  const bindings: CoreBindings = {
    AUTH_DATABASE: database.authDatabase,
    DB: applicationStorage,
    ASSETS: makeFilesystemAssetFetcher(config.ASSETS_DIRECTORY),
    INBOUND_DEAD_LETTER_QUEUE_NAME: queueNames.inboundDeadLetter,
    DELIVERY_RESULT_QUEUE_NAME: queueNames.deliveryResult,
    DELIVERY_RESULT_DEAD_LETTER_QUEUE_NAME: queueNames.deliveryResultDeadLetter,
    OUTBOUND_DEAD_LETTER_QUEUE_NAME: queueNames.outboundDeadLetter,
    OWNER_ID: config.OWNER_ID,
    OWNER_TIME_ZONE: config.OWNER_TIME_ZONE,
    DATA_KEK_ACTIVE_VERSION: config.DATA_KEK_ACTIVE_VERSION,
    DATA_KEK_KEYRING_JSON: config.DATA_KEK_KEYRING_JSON,
    DATA_LOOKUP_KEY: config.DATA_LOOKUP_KEY,
    INGRESS_CALLER_SECRET: config.INGRESS_CALLER_SECRET,
    EGRESS_CALLER_SECRET: config.EGRESS_CALLER_SECRET,
    CHANNEL_EGRESS_URL: config.CHANNEL_EGRESS_URL,
    BETTER_AUTH_SECRET: config.AGENT_CALLER_SECRET,
    SETUP_TOKEN: config.SETUP_TOKEN,
    OWNER_ACCESS_EMAIL: config.OWNER_ACCESS_EMAIL,
    AGENT_CALLER_SECRET: config.AGENT_CALLER_SECRET,
    AGENT_URL: config.AGENT_URL,
    AGENT_ADMIN_URL: config.AGENT_URL,
    UI_BASE_URL: config.UI_BASE_URL,
    BOB_MODEL: config.BOB_MODEL,
    BOB_PROVIDER: "openai-codex",
    BOB_RUN_TOKEN_BUDGET: config.BOB_RUN_TOKEN_BUDGET,
    BOB_DAILY_TOKEN_BUDGET: config.BOB_DAILY_TOKEN_BUDGET
  }
  let composition: ReturnType<typeof composeCoreWithRuntime>
  let ownerTurnEngine: ReturnType<typeof makeOwnerTurnEngine>
  const runCoordinator = makeQueuedOwnerRunCoordinator({
    wakeJobs: makeBullMqJobPublisher(ownerWakeQueue, "owner-wake"),
    async accept(request) {
      const offered = await ownerTurnEngine.accept(
        request.job,
        request.correlationId,
        request.traceparent
      )
      return Response.json(
        { ok: true, turnId: offered.turnId, revision: offered.revision },
        { status: 202 }
      )
    }
  })
  const runtime: CoreRuntimeAdapters = {
    applicationStorage,
    channelProviderId: "sendblue",
    events: nodeEventSink(),
    jobQueue,
    objectStorage: makeFilesystemPrivateObjectStore(config.OBJECT_STORAGE_DIRECTORY),
    runCoordinator
  }
  composition = composeCoreWithRuntime(bindings, runtime)
  ownerTurnEngine = makeOwnerTurnEngine({
    turns: composition.services.turns,
    serialize: (operation) => operation(),
    schedule: (at) => runCoordinator.wake({ ownerId: config.OWNER_ID, wakeAt: at.toISOString() }),
    process: (snapshot) => processConversationTurn(snapshot, bindings, composition),
    async steer(runId, correlationId, traceparent) {
      try {
        const headers = new Headers({
          "content-type": "application/json",
          "x-bob-caller-token": config.AGENT_CALLER_SECRET,
          "x-bob-correlation-id": correlationId
        })
        if (traceparent !== undefined) headers.set("traceparent", traceparent)
        const response = await fetch(`${config.AGENT_URL}/v1/steer`, {
          method: "POST",
          headers,
          body: JSON.stringify({ runId })
        })
        if (!response.ok) return "unavailable"
        return Schema.decodeUnknownSync(
          Schema.Struct({ status: Schema.Literals(["aborted_model", "queued", "missing"]) })
        )(await response.json()).status
      } catch {
        return "unavailable"
      }
    }
  })
  const routes = [
    ...makeCoreJobConsumerRoutes(composition, queueNames),
    {
      queueName: queueNames.ownerWake,
      processor: decodeJobProcessor(
        { decode: (input) => Schema.decodeUnknownSync(OwnerWakeJob)(input) },
        makeOwnerWakeJobProcessor({ wake: () => ownerTurnEngine.wake() }),
        retryJob(30_000)
      )
    }
  ]
  const workers = startBullMqWorkerHost(routes, {
    connection,
    prefix: "bob",
    onUnexpectedError(jobQueueName, error) {
      console.error(
        JSON.stringify({
          type: "job_queue_processor_failure",
          jobQueueName,
          errorName: error.name,
          applicationStorageCode: applicationStorageErrorCode(error),
          applicationStorageQuery: applicationStorageErrorQuery(error)
        })
      )
    }
  })
  await workers.ready()

  let schedulerActive = false
  const schedulerTimer = setInterval(() => {
    if (schedulerActive) return
    schedulerActive = true
    const scheduledAt = new Date()
    void handleScheduled(
      bindings,
      { correlationId: crypto.randomUUID(), scheduledAt },
      undefined,
      () => composition
    )
      .catch((error: Error) =>
        console.error(JSON.stringify({ type: "scheduler_work_failure", errorName: error.name }))
      )
      .finally(() => {
        schedulerActive = false
      })
  }, config.SCHEDULER_INTERVAL_MS)

  const server = createServer(async (incoming, outgoing) => {
    try {
      const request = await webRequest(incoming)
      const response = await handleHttp(request, bindings, undefined, () => composition)
      if (
        config.AUTO_ENQUEUE_INBOUND === "true" &&
        request.method === "POST" &&
        new URL(request.url).pathname === "/internal/inbound" &&
        response.ok
      ) {
        const acceptance = Schema.decodeUnknownSync(InboundAcceptance)(
          await response.clone().json()
        )
        if (acceptance.shouldEnqueue) {
          await jobQueue.inbound.publish({ eventId: acceptance.eventId })
          await composition.services.conversations.markEnqueued(
            acceptance.eventId,
            new Date().toISOString()
          )
        }
      }
      await writeWebResponse(response, outgoing)
    } catch (error) {
      console.error(
        JSON.stringify({
          type: "http_request_failure",
          errorName: error instanceof Error ? error.name : "UnknownError",
          errorMessage: error instanceof Error ? error.message : "Unknown request failure"
        })
      )
      outgoing.writeHead(500).end()
    }
  })
  server.listen(config.PORT, "0.0.0.0")

  async function shutdown(): Promise<void> {
    clearInterval(schedulerTimer)
    server.close()
    await workers.close()
    await Promise.all([inboundQueue.close(), outboundQueue.close(), ownerWakeQueue.close()])
    await database.close()
  }
  process.once("SIGTERM", () => void shutdown())
  process.once("SIGINT", () => void shutdown())
}

void main().catch((error: Error) => {
  console.error(JSON.stringify({ service: "core-runtime", error: error.message }))
  process.exitCode = 1
})
