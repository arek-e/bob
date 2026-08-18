import type { CoreAdapters } from "@bob/core-types/adapters"
import type { CoreBindings } from "@bob/core-types/bindings"

import {
  makeAgentRunContinuationDispatcher,
  makeAgentRunDispatcher
} from "@bob/agent-runs-service/dispatcher"
import { AgentRuns } from "@bob/agent-runs-types/agent-runs"
import { AgentRunContinuationJob } from "@bob/agent-runs-types/worker-gateway"
import { InboundAcceptance } from "@bob/conversations-types/channel"
import { ConversationStore } from "@bob/conversations-types/store"
import { makeOwnerTurnEngine, processConversationTurnEffect } from "@bob/core-service"
import { OwnerWakeJob } from "@bob/core-types/jobs"
import { PostgresqlDatabase, postgresqlDatabaseLayer } from "@bob/db-service/postgresql"
import { agentRuns } from "@bob/db-service/schema/conversations"
import { makeBullMqJobPublisher } from "@bob/job-queue-runtime/bullmq"
import { startBullMqWorkerHost } from "@bob/job-queue-runtime/bullmq-host"
import { decodeJobProcessor, retryJob } from "@bob/job-queue-types"
import { filesystemObjectStorageLayer } from "@bob/object-store-runtime/filesystem"
import { emitHealth, flushTelemetry, nodeTelemetryLayer, withBobRootSpan } from "@bob/observability"
import { Queue, type ConnectionOptions } from "bullmq"
import { and, eq } from "drizzle-orm"
import { Effect, ManagedRuntime, Schema } from "effect"
import { createServer } from "node:http"
import { resolve } from "node:path"

import { composeCore } from "./composition.ts"
import { readCoreRuntimeConfiguration } from "./configuration.ts"
import { handleHttp } from "./entrypoints/http.ts"
import { makeCoreJobConsumerRoutes } from "./entrypoints/queue.ts"
import { handleScheduled } from "./entrypoints/scheduled.ts"
import { webRequest, writeWebResponse } from "./node-http.ts"
import {
  makeOwnerWakeJobProcessor,
  makePostgresqlOwnerWakeOutbox,
  makeQueuedOwnerRunCoordinator,
  repairOwnerWakeOutbox
} from "./runtime/run-coordinator.ts"
import { makeFilesystemAssetFetcher } from "./static-assets.ts"

const staticQueueNames = {
  inbound: "bob-inbound",
  inboundDeadLetter: "bob-inbound-dead-letter",
  outbound: "bob-outbound",
  outboundDeadLetter: "bob-outbound-dead-letter",
  deliveryResult: "bob-delivery-result",
  deliveryResultDeadLetter: "bob-delivery-result-dead-letter",
  ownerWake: "bob-owner-wake",
  agentRunContinuation: "bob-agent-run-continuation"
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
  const queueNames = {
    ...staticQueueNames,
    agentRun: `bob-agent-runs-${config.AGENT_EXECUTION_POOL_ID}`
  } as const
  const databaseRuntime = ManagedRuntime.make(
    postgresqlDatabaseLayer(config.DATABASE_URL, {
      migrationsFolder: resolve(process.cwd(), "dist/migrations")
    })
  )
  const database = await databaseRuntime.runPromise(PostgresqlDatabase)
  if (config.AUTO_MIGRATE === "true") await databaseRuntime.runPromise(database.migrate)
  const connection = redisConnection(config.JOB_QUEUE_URL)
  const queueOptions = { connection, prefix: "bob" }
  const inboundQueue = new Queue(queueNames.inbound, queueOptions)
  const outboundQueue = new Queue(queueNames.outbound, queueOptions)
  const ownerWakeQueue = new Queue(queueNames.ownerWake, queueOptions)
  const agentRunQueue = new Queue(queueNames.agentRun, queueOptions)
  const agentRunContinuationQueue = new Queue(queueNames.agentRunContinuation, queueOptions)
  const jobQueue = Object.freeze({
    inbound: makeBullMqJobPublisher(inboundQueue, "inbound"),
    outbound: makeBullMqJobPublisher(outboundQueue, "outbound"),
    ownerWake: makeBullMqJobPublisher(ownerWakeQueue, "owner-wake")
  })
  const applicationStorage = database.applicationStorage
  const ownerWakeOutbox = makePostgresqlOwnerWakeOutbox(applicationStorage)
  const agentRunDispatcher = makeAgentRunDispatcher(applicationStorage, {
    forExecutionPool(executionPoolId) {
      if (executionPoolId !== config.AGENT_EXECUTION_POOL_ID) {
        throw new Error(`Unsupported Agent execution pool: ${executionPoolId}`)
      }
      return makeBullMqJobPublisher(agentRunQueue, "agent-run")
    }
  })
  const agentRunContinuationDispatcher = makeAgentRunContinuationDispatcher(
    applicationStorage,
    makeBullMqJobPublisher(agentRunContinuationQueue, "agent-run-continuation")
  )
  const bindings: CoreBindings = {
    AUTH_DATABASE: database.authDatabase,
    DB: applicationStorage,
    ASSETS: makeFilesystemAssetFetcher(config.ASSETS_DIRECTORY),
    INBOUND_DEAD_LETTER_QUEUE_NAME: queueNames.inboundDeadLetter,
    DELIVERY_RESULT_QUEUE_NAME: queueNames.deliveryResult,
    DELIVERY_RESULT_DEAD_LETTER_QUEUE_NAME: queueNames.deliveryResultDeadLetter,
    OUTBOUND_DEAD_LETTER_QUEUE_NAME: queueNames.outboundDeadLetter,
    OWNER_TIME_ZONE: config.OWNER_TIME_ZONE,
    DATA_KEK_ACTIVE_VERSION: config.DATA_KEK_ACTIVE_VERSION,
    DATA_KEK_KEYRING_JSON: config.DATA_KEK_KEYRING_JSON,
    DATA_LOOKUP_KEY: config.DATA_LOOKUP_KEY,
    INGRESS_CALLER_SECRET: config.INGRESS_CALLER_SECRET,
    EGRESS_CALLER_SECRET: config.EGRESS_CALLER_SECRET,
    CHANNEL_EGRESS_URL: config.CHANNEL_EGRESS_URL,
    BETTER_AUTH_SECRET: config.BETTER_AUTH_SECRET,
    SETUP_TOKEN: config.SETUP_TOKEN,
    OWNER_ENROLLMENT_SECRET: config.OWNER_ENROLLMENT_SECRET,
    AGENT_CALLER_SECRET: config.AGENT_CALLER_SECRET,
    AGENT_URL: config.AGENT_URL,
    AGENT_ADMIN_URL: config.AGENT_URL,
    AGENT_EXECUTION_POOL_ID: config.AGENT_EXECUTION_POOL_ID,
    ASYNC_AGENT_RUNS: "true",
    UI_BASE_URL: config.UI_BASE_URL,
    BOB_MODEL: config.BOB_MODEL,
    BOB_PROVIDER: config.BOB_PROVIDER,
    BOB_RELEASE_SHA: config.BOB_RELEASE_SHA,
    OTEL_EXPORTER_OTLP_ENDPOINT: config.OTEL_EXPORTER_OTLP_ENDPOINT,
    BOB_RUN_TOKEN_BUDGET: config.BOB_RUN_TOKEN_BUDGET,
    BOB_DAILY_TOKEN_BUDGET: config.BOB_DAILY_TOKEN_BUDGET
  }
  if (config.OWNER_ID !== undefined) bindings.OWNER_ID = config.OWNER_ID
  if (config.OWNER_ACCESS_EMAIL !== undefined)
    bindings.OWNER_ACCESS_EMAIL = config.OWNER_ACCESS_EMAIL
  let composition: ReturnType<typeof composeCore>
  let ownerTurnEngine: ReturnType<typeof makeOwnerTurnEngine>
  const runCoordinator = makeQueuedOwnerRunCoordinator({
    wakeJobs: jobQueue.ownerWake,
    wakeOutbox: ownerWakeOutbox,
    async accept(request) {
      const offered = await composition.runtime.runPromise(
        ownerTurnEngine.accept(request.job, request.correlationId, request.traceparent)
      )
      return Response.json(
        { ok: true, turnId: offered.turnId, revision: offered.revision },
        { status: 202 }
      )
    }
  })
  const runtime: CoreAdapters = {
    applicationStorage,
    channelProviderId: "sendblue",
    jobQueue,
    objectStorage: filesystemObjectStorageLayer(config.OBJECT_STORAGE_DIRECTORY),
    runCoordinator
  }
  composition = composeCore(
    bindings,
    runtime,
    nodeTelemetryLayer({
      endpoint: config.OTEL_EXPORTER_OTLP_ENDPOINT,
      serviceName: "bob-core-runtime",
      serviceVersion: config.BOB_RELEASE_SHA,
      deploymentEnvironment: "prod"
    })
  )
  ownerTurnEngine = makeOwnerTurnEngine({
    schedule: (at, ownerId) => runCoordinator.wake({ ownerId, wakeAt: at.toISOString() }),
    process: (snapshot) =>
      composition.runtime.runPromise(
        processConversationTurnEffect(snapshot, bindings, composition)
      ),
    async steer(runId, ownerId, correlationId, traceparent, turn) {
      if (bindings.ASYNC_AGENT_RUNS === "true") {
        try {
          await composition.runtime.runPromise(
            AgentRuns.use((runs) =>
              runs.cancel({
                runId,
                ownerId,
                idempotencyKey: `turn-${turn.turnId}-${turn.revision}`,
                reason: "superseded"
              })
            )
          )
          return "queued"
        } catch {
          return "missing"
        }
      }
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
        makeOwnerWakeJobProcessor({
          wake: (job) => composition.runtime.runPromise(ownerTurnEngine.wake(job.ownerId)),
          complete: (wakeId) => ownerWakeOutbox.markCompleted(wakeId, new Date().toISOString())
        }),
        retryJob(30_000)
      )
    },
    {
      queueName: queueNames.agentRunContinuation,
      processor: decodeJobProcessor(
        { decode: (input) => Schema.decodeUnknownSync(AgentRunContinuationJob)(input) },
        {
          async process(job) {
            const [run] = await Effect.runPromise(
              applicationStorage
                .select({ ownerId: agentRuns.userId })
                .from(agentRuns)
                .where(
                  and(
                    eq(agentRuns.id, job.runId),
                    eq(agentRuns.status, "awaiting_finalization"),
                    eq(agentRuns.activeAttemptFence, job.generation)
                  )
                )
                .limit(1)
            )
            if (run !== undefined) await runCoordinator.wake({ ownerId: run.ownerId })
            return { state: "complete" as const }
          }
        },
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

  let agentRunDispatchActive = false
  const agentRunDispatchTimer = setInterval(() => {
    if (agentRunDispatchActive) return
    agentRunDispatchActive = true
    void Promise.all([
      agentRunDispatcher.dispatchPending(),
      agentRunContinuationDispatcher.dispatchPending()
    ])
      .catch((error: Error) =>
        console.error(JSON.stringify({ type: "agent_run_dispatch_failure", errorName: error.name }))
      )
      .finally(() => {
        agentRunDispatchActive = false
      })
  }, 1_000)

  let schedulerActive = false
  const schedulerTimer = setInterval(() => {
    if (schedulerActive) return
    schedulerActive = true
    const scheduledAt = new Date()
    void repairOwnerWakeOutbox(ownerWakeOutbox, jobQueue.ownerWake, scheduledAt)
      .then(() =>
        handleScheduled(
          bindings,
          { correlationId: crypto.randomUUID(), scheduledAt },
          () => composition
        )
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
      const response = await handleHttp(request, bindings, () => composition)
      if (
        config.AUTO_ENQUEUE_INBOUND === "true" &&
        request.method === "POST" &&
        new URL(request.url).pathname === "/internal/inbound" &&
        response.ok
      ) {
        const acceptance = Schema.decodeUnknownSync(InboundAcceptance)(
          await response.clone().json()
        )
        if (acceptance.shouldEnqueue && (acceptance.pendingAttachmentOrdinals?.length ?? 0) === 0) {
          await jobQueue.inbound.publish({ eventId: acceptance.eventId })
          await composition.runtime.runPromise(
            Effect.flatMap(ConversationStore, (conversations) =>
              conversations.markEnqueued(acceptance.eventId, new Date().toISOString())
            )
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
      outgoing
        .writeHead(
          error instanceof RangeError && error.message === "request_body_too_large" ? 413 : 500
        )
        .end()
    }
  })
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const rejectListen = (error: Error) => rejectPromise(error)
    server.once("error", rejectListen)
    server.listen(config.PORT, "0.0.0.0", () => {
      server.off("error", rejectListen)
      resolvePromise()
    })
  })
  const readyCorrelationId = crypto.randomUUID()
  await composition.runtime.runPromise(
    withBobRootSpan(
      {
        name: "bob.runtime.ready",
        correlationId: readyCorrelationId,
        feature: "runtime_readiness"
      },
      Effect.gen(function* () {
        yield* emitHealth({
          type: "runtime_ready",
          correlationId: readyCorrelationId,
          status: "completed",
          role: "core"
        })
        yield* flushTelemetry
      })
    )
  )

  async function shutdown(): Promise<void> {
    clearInterval(schedulerTimer)
    clearInterval(agentRunDispatchTimer)
    server.close()
    await workers.close()
    await composition.runtime.dispose()
    await Promise.all([
      inboundQueue.close(),
      outboundQueue.close(),
      ownerWakeQueue.close(),
      agentRunQueue.close(),
      agentRunContinuationQueue.close()
    ])
    await databaseRuntime.dispose()
  }
  process.once("SIGTERM", () => void shutdown())
  process.once("SIGINT", () => void shutdown())
}

void main().catch((error: Error) => {
  console.error(JSON.stringify({ service: "core-runtime", error: error.message }))
  process.exitCode = 1
})
