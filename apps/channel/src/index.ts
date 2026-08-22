import type { DeliveryResult } from "@bob/delivery-types/delivery"

import { OutboundJob, type InboundJob } from "@bob/core-types/jobs"
import { makeBullMqJobPublisher } from "@bob/job-queue-runtime/bullmq"
import { startBullMqWorkerHost } from "@bob/job-queue-runtime/bullmq-host"
import { completeJob, decodeJobProcessor, retryJob, type JobPublisher } from "@bob/job-queue-types"
import { nodeTelemetryLayer } from "@bob/observability"
import { Queue as BullQueue, type ConnectionOptions } from "bullmq"
import { Config, Effect, Layer, ManagedRuntime, Redacted, Schema } from "effect"
import { createServer } from "node:http"

import type { EgressBindings } from "./egress/bindings.ts"
import type { IngressBindings } from "./ingress/bindings.ts"

import { sendblueEgressLayer } from "./egress/composition.ts"
import { handleEgressHttp } from "./egress/index.ts"
import { processOutboundJob } from "./egress/queue.ts"
import { sendblueIngressLayer } from "./ingress/composition.ts"
import { handleIngressHttp } from "./ingress/http.ts"
import { webRequest, writeWebResponse } from "./node-http.ts"
import {
  requiredWebhooksFromStatusCallback,
  SendblueProvider,
  sendblueProviderLayer
} from "./sendblue/provider.ts"

const Environment = Config.all({
  PORT: Config.schema(Schema.NumberFromString, "PORT"),
  CORE_URL: Config.url("CORE_URL"),
  JOB_QUEUE_URL: Config.url("JOB_QUEUE_URL"),
  CORE_CALLER_SECRET: Config.redacted("CORE_CALLER_SECRET"),
  SENDBLUE_ACCOUNT_ID: Config.nonEmptyString("SENDBLUE_ACCOUNT_ID"),
  SENDBLUE_LINE_ID: Config.nonEmptyString("SENDBLUE_LINE_ID"),
  SENDBLUE_API_KEY_ID: Config.nonEmptyString("SENDBLUE_API_KEY_ID"),
  SENDBLUE_API_SECRET_KEY: Config.redacted("SENDBLUE_API_SECRET_KEY"),
  SENDBLUE_WEBHOOK_SIGNING_SECRET: Config.redacted("SENDBLUE_WEBHOOK_SIGNING_SECRET"),
  SENDBLUE_FROM_NUMBER: Config.schema(
    Schema.String.check(Schema.isPattern(/^\+[1-9]\d{7,14}$/)),
    "SENDBLUE_FROM_NUMBER"
  ),
  SENDBLUE_STATUS_CALLBACK_URL: Config.url("SENDBLUE_STATUS_CALLBACK_URL"),
  SENDBLUE_MEDIA_HOSTS: Config.nonEmptyString("SENDBLUE_MEDIA_HOSTS").pipe(
    Config.withDefault("cdn.sendblue.co,storage.googleapis.com")
  ),
  OTEL_EXPORTER_OTLP_ENDPOINT: Config.url("OTEL_EXPORTER_OTLP_ENDPOINT"),
  BOB_RELEASE_SHA: Config.schema(
    Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/)),
    "BOB_RELEASE_SHA"
  )
})

function redisConnection(urlValue: string): ConnectionOptions {
  const url = new URL(urlValue)
  const connection: ConnectionOptions = { host: url.hostname, port: Number(url.port || "6379") }
  if (url.password.length > 0) connection.password = decodeURIComponent(url.password)
  if (url.protocol === "rediss:") connection.tls = {}
  return connection
}

interface RuntimeFetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>
}

interface RuntimeQueue<Job> {
  send(job: Job): Promise<void>
  sendBatch(messages: readonly { body: Job; delaySeconds?: number }[]): Promise<void>
}

function makeHttpFetcher(baseUrl: string): RuntimeFetcher {
  return {
    fetch(input, init) {
      const request = input instanceof Request ? input : new Request(input, init)
      const source = new URL(request.url)
      return fetch(new URL(`${source.pathname}${source.search}`, baseUrl), request)
    }
  }
}

function makeQueueBinding<Job>(publisher: JobPublisher<Job>): RuntimeQueue<Job> {
  return {
    send: (job) => publisher.publish(job),
    async sendBatch(messages) {
      await Promise.all(
        messages.map((message) =>
          publisher.publish(
            message.body,
            message.delaySeconds === undefined
              ? undefined
              : { delayMs: message.delaySeconds * 1_000 }
          )
        )
      )
    }
  }
}

async function main(): Promise<void> {
  const config = await Effect.runPromise(Environment)
  const coreUrl = config.CORE_URL.toString().replace(/\/$/u, "")
  const connection = redisConnection(config.JOB_QUEUE_URL.toString())
  const queueOptions = { connection, prefix: "bob" }
  const inboundQueue = new BullQueue("bob-inbound", queueOptions)
  const deliveryResultQueue = new BullQueue("bob-delivery-result", queueOptions)
  const core = makeHttpFetcher(coreUrl)
  const inboundQueueBinding = makeQueueBinding<InboundJob>(
    makeBullMqJobPublisher(inboundQueue, "inbound")
  )
  const deliveryResultQueueBinding = makeQueueBinding<DeliveryResult>(
    makeBullMqJobPublisher(deliveryResultQueue, "delivery-result")
  )
  const callerSecret = Redacted.value(config.CORE_CALLER_SECRET)
  const webhookSecret = Redacted.value(config.SENDBLUE_WEBHOOK_SIGNING_SECRET)
  const ingressBindings: IngressBindings = {
    CORE: core,
    MEDIA: { fetch: (input, init) => fetch(input, init) },
    INBOUND_QUEUE: inboundQueueBinding,
    SENDBLUE_ACCOUNT_ID: config.SENDBLUE_ACCOUNT_ID,
    SENDBLUE_LINE_ID: config.SENDBLUE_LINE_ID,
    SENDBLUE_WEBHOOK_SIGNING_SECRET: webhookSecret,
    SENDBLUE_FROM_NUMBER: config.SENDBLUE_FROM_NUMBER,
    CORE_CALLER_SECRET: callerSecret,
    SENDBLUE_MEDIA_HOSTS: config.SENDBLUE_MEDIA_HOSTS
  }
  const egressBindings: EgressBindings = {
    CORE: core,
    INGRESS: makeHttpFetcher("http://127.0.0.1:8786"),
    DELIVERY_RESULT_QUEUE: deliveryResultQueueBinding,
    SENDBLUE_WEBHOOK_SIGNING_SECRET: webhookSecret,
    SENDBLUE_FROM_NUMBER: config.SENDBLUE_FROM_NUMBER,
    SENDBLUE_STATUS_CALLBACK_URL: config.SENDBLUE_STATUS_CALLBACK_URL.toString(),
    CORE_CALLER_SECRET: callerSecret
  }
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      sendblueIngressLayer(ingressBindings),
      sendblueEgressLayer(egressBindings),
      sendblueProviderLayer({
        apiKeyId: config.SENDBLUE_API_KEY_ID,
        apiSecretKey: config.SENDBLUE_API_SECRET_KEY
      }),
      nodeTelemetryLayer({
        endpoint: config.OTEL_EXPORTER_OTLP_ENDPOINT.toString().replace(/\/$/u, ""),
        serviceName: "bob-channel",
        serviceVersion: config.BOB_RELEASE_SHA,
        deploymentEnvironment: "prod"
      })
    )
  )
  const workers = startBullMqWorkerHost(
    [
      {
        queueName: "bob-outbound",
        processor: decodeJobProcessor(
          { decode: (input) => Schema.decodeUnknownSync(OutboundJob)(input) },
          {
            process: async (job) =>
              (await runtime.runPromise(processOutboundJob(job))) === "done"
                ? completeJob
                : retryJob(30_000)
          },
          retryJob(30_000)
        )
      }
    ],
    { connection, prefix: "bob" }
  )
  await workers.ready()

  const server = createServer(async (incoming, outgoing) => {
    try {
      const request = await webRequest(incoming)
      const url = new URL(request.url)
      const response =
        url.pathname === "/health"
          ? Response.json({ healthy: true, service: "channel-runtime", version: 1 })
          : url.pathname.startsWith("/internal/")
            ? await runtime.runPromise(handleEgressHttp(request))
            : await runtime.runPromise(handleIngressHttp(request))
      await writeWebResponse(response, outgoing)
    } catch {
      outgoing.writeHead(500).end()
    }
  })
  server.listen(config.PORT, "0.0.0.0")

  // Keep the provider's account hooks aligned with this release. This runs
  // after the HTTP server starts, so a slow provider API cannot delay webhook
  // readiness. The operation is idempotent and fails open: recovery remains
  // available if Sendblue is temporarily unavailable.
  const requiredWebhooks = requiredWebhooksFromStatusCallback(
    config.SENDBLUE_STATUS_CALLBACK_URL.toString(),
    webhookSecret
  )
  void runtime
    .runPromise(
      Effect.flatMap(SendblueProvider, (provider) =>
        provider.reconcileWebhooks(requiredWebhooks, false)
      )
    )
    .then((plan) => {
      console.log(
        JSON.stringify({
          type: "sendblue_webhook_reconciliation",
          status: "completed",
          state: plan.state,
          receiveCount: plan.receiveCount,
          outboundCount: plan.outboundCount
        })
      )
    })
    .catch(() => {
      console.error(
        JSON.stringify({
          type: "sendblue_webhook_reconciliation",
          status: "failed",
          code: "provider_reconciliation_failed"
        })
      )
    })

  async function shutdown(): Promise<void> {
    server.close()
    await workers.close()
    await Promise.all([inboundQueue.close(), deliveryResultQueue.close()])
    await runtime.dispose()
  }
  process.once("SIGTERM", () => void shutdown())
  process.once("SIGINT", () => void shutdown())
}

void main().catch((error: Error) => {
  console.error(JSON.stringify({ service: "channel-runtime", error: error.message }))
  process.exitCode = 1
})
