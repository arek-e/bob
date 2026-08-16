import {
  createPostgresqlApplicationStorageAdapter,
  type PostgresqlSchemaSnapshot
} from "@bob/application-storage-postgresql/postgresql"
import { InboundAcceptance } from "@bob/contracts/channel"
import { OwnerWakeJob } from "@bob/contracts/jobs"
import snapshot from "@bob/core-worker/database-snapshot" with { type: "json" }
import { makeCoreJobConsumerRoutes } from "@bob/core-worker/job-processors"
import {
  composeCoreWithRuntime,
  createCoreDatabase,
  handleScheduled,
  handleHttp,
  makeOwnerWakeJobProcessor,
  makeQueuedOwnerRunCoordinator,
  makeOwnerTurnEngine,
  processConversationTurn,
  type CoreBindings,
  type CoreRuntimeAdapters
} from "@bob/core-worker/runtime"
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

const authSchema = `
CREATE TABLE IF NOT EXISTS auth_user (id text PRIMARY KEY, name text NOT NULL, email text NOT NULL UNIQUE, email_verified integer NOT NULL, image text, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS auth_session (id text PRIMARY KEY, expires_at timestamptz NOT NULL, token text NOT NULL UNIQUE, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, ip_address text, user_agent text, user_id text NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS auth_account (id text PRIMARY KEY, account_id text NOT NULL, provider_id text NOT NULL, user_id text NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE, access_token text, refresh_token text, id_token text, access_token_expires_at timestamptz, refresh_token_expires_at timestamptz, scope text, password text, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS auth_verification (id text PRIMARY KEY, identifier text NOT NULL, value text NOT NULL, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS auth_rate_limit (id text PRIMARY KEY, key text NOT NULL UNIQUE, count integer NOT NULL, last_request bigint NOT NULL);
CREATE INDEX IF NOT EXISTS auth_session_user_id_idx ON auth_session(user_id);
CREATE INDEX IF NOT EXISTS auth_account_user_id_idx ON auth_account(user_id);
CREATE INDEX IF NOT EXISTS auth_verification_identifier_idx ON auth_verification(identifier);
CREATE TABLE IF NOT EXISTS retrieval_documents_fts (document_id text PRIMARY KEY, user_id text NOT NULL, search_text text NOT NULL, source_label text NOT NULL);
CREATE OR REPLACE FUNCTION sync_retrieval_documents_fts() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM retrieval_documents_fts WHERE document_id = OLD.id;
    RETURN OLD;
  END IF;
  DELETE FROM retrieval_documents_fts WHERE document_id = NEW.id;
  IF NEW.deleted_at IS NULL THEN
    INSERT INTO retrieval_documents_fts(document_id, user_id, search_text, source_label)
    VALUES (NEW.id, NEW.user_id, NEW.search_text, NEW.source_label);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS retrieval_documents_fts_sync ON search_documents;
CREATE TRIGGER retrieval_documents_fts_sync AFTER INSERT OR UPDATE OR DELETE ON search_documents
FOR EACH ROW EXECUTE FUNCTION sync_retrieval_documents_fts();
`

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
  const postgres = createPostgresqlApplicationStorageAdapter(config.APPLICATION_STORAGE_URL)
  // SAFETY: This checked-in snapshot uses the PostgresqlSchemaSnapshot format.
  await postgres.migrate(snapshot as PostgresqlSchemaSnapshot, authSchema)
  const connection = redisConnection(config.JOB_QUEUE_URL)
  const queueOptions = { connection, prefix: "bob" }
  const inboundQueue = new Queue(queueNames.inbound, queueOptions)
  const outboundQueue = new Queue(queueNames.outbound, queueOptions)
  const ownerWakeQueue = new Queue(queueNames.ownerWake, queueOptions)
  const jobQueue = Object.freeze({
    inbound: makeBullMqJobPublisher(inboundQueue, "inbound"),
    outbound: makeBullMqJobPublisher(outboundQueue, "outbound")
  })
  // SAFETY: The PostgreSQL Adapter implements the D1 methods used by the Drizzle D1 driver.
  const d1Binding = postgres as never
  // SAFETY: Portable composition never reads Cloudflare-only bindings from this sentinel.
  const unavailablePlatformBinding = {} as never
  const applicationStorage = createCoreDatabase(d1Binding)
  const bindings: CoreBindings = {
    DB: d1Binding,
    PRIVATE_OBJECTS: unavailablePlatformBinding,
    ASSETS: makeFilesystemAssetFetcher(config.ASSETS_DIRECTORY),
    INBOUND_QUEUE: unavailablePlatformBinding,
    INBOUND_DEAD_LETTER_QUEUE_NAME: queueNames.inboundDeadLetter,
    DELIVERY_RESULT_QUEUE_NAME: queueNames.deliveryResult,
    DELIVERY_RESULT_DEAD_LETTER_QUEUE_NAME: queueNames.deliveryResultDeadLetter,
    OUTBOUND_DEAD_LETTER_QUEUE_NAME: queueNames.outboundDeadLetter,
    OUTBOUND_QUEUE: unavailablePlatformBinding,
    OWNER_RUN_COORDINATOR: unavailablePlatformBinding,
    OWNER_ID: config.OWNER_ID,
    OWNER_TIME_ZONE: config.OWNER_TIME_ZONE,
    DATA_KEK_ACTIVE_VERSION: config.DATA_KEK_ACTIVE_VERSION,
    DATA_KEK_KEYRING_JSON: config.DATA_KEK_KEYRING_JSON,
    DATA_LOOKUP_KEY: config.DATA_LOOKUP_KEY,
    INGRESS_CALLER_SECRET: config.INGRESS_CALLER_SECRET,
    EGRESS_CALLER_SECRET: config.EGRESS_CALLER_SECRET,
    CHANNEL_EGRESS_URL: config.CHANNEL_EGRESS_URL,
    BETTER_AUTH_SECRET: config.AGENT_CALLER_SECRET,
    ACCESS_TEAM_DOMAIN: "compose.cloudflareaccess.com",
    CORE_ACCESS_AUDIENCE: "bob-compose-core",
    SETUP_ACCESS_AUDIENCE: "bob-compose-setup",
    OWNER_ACCESS_EMAIL: "owner@localhost",
    AGENT_CALLER_SUBJECT: "bob-compose-agent",
    AGENT_URL: config.AGENT_URL,
    AGENT_ACCESS_CLIENT_ID: "bob-compose-core",
    AGENT_ACCESS_CLIENT_SECRET: config.AGENT_CALLER_SECRET,
    AGENT_ADMIN_URL: config.AGENT_URL,
    AGENT_ADMIN_ACCESS_CLIENT_ID: "bob-compose-core",
    AGENT_ADMIN_ACCESS_CLIENT_SECRET: config.AGENT_CALLER_SECRET,
    UI_BASE_URL: "http://127.0.0.1",
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
          "CF-Access-Client-Secret": config.AGENT_CALLER_SECRET,
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
      const response = await handleHttp(
        request,
        bindings,
        async (authorizedRequest, access) => {
          if (
            authorizedRequest.headers.get("CF-Access-Client-Secret") !== config.AGENT_CALLER_SECRET
          ) {
            throw new Error("access_denied")
          }
          return { subject: "", commonName: "bob-compose-agent", audience: [access.accessAudience] }
        },
        undefined,
        () => composition
      )
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
    } catch {
      outgoing.writeHead(500).end()
    }
  })
  server.listen(config.PORT, "0.0.0.0")

  async function shutdown(): Promise<void> {
    clearInterval(schedulerTimer)
    server.close()
    await workers.close()
    await Promise.all([inboundQueue.close(), outboundQueue.close(), ownerWakeQueue.close()])
    await postgres.close()
  }
  process.once("SIGTERM", () => void shutdown())
  process.once("SIGINT", () => void shutdown())
}

void main().catch((error: Error) => {
  console.error(JSON.stringify({ service: "core-runtime", error: error.message }))
  process.exitCode = 1
})
