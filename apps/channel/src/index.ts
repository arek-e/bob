import type { DeliveryResult } from "@bob/contracts/delivery"
import type { EgressBindings } from "@bob/sendblue-runtime/egress/bindings"
import type { IngressBindings } from "@bob/sendblue-runtime/ingress/bindings"

import { OutboundJob, type InboundJob } from "@bob/contracts/jobs"
import { completeJob, decodeJobProcessor, retryJob, type JobPublisher } from "@bob/job-queue"
import { makeBullMqJobPublisher } from "@bob/job-queue/bullmq"
import { startBullMqWorkerHost } from "@bob/job-queue/bullmq-host"
import egressWorker from "@bob/sendblue-runtime/egress"
import { processOutboundJob } from "@bob/sendblue-runtime/egress/queue"
import { handleIngressHttp } from "@bob/sendblue-runtime/ingress/http"
import { Queue as BullQueue, type ConnectionOptions } from "bullmq"
import { Schema } from "effect"
import { createServer } from "node:http"

import { webRequest, writeWebResponse } from "./node-http.ts"

const Environment = Schema.Struct({
  PORT: Schema.NumberFromString,
  CORE_URL: Schema.URLFromString,
  JOB_QUEUE_URL: Schema.URLFromString,
  CORE_CALLER_SECRET: Schema.String.check(Schema.isMinLength(32)),
  SENDBLUE_ACCOUNT_ID: Schema.String.check(Schema.isMinLength(1)),
  SENDBLUE_LINE_ID: Schema.String.check(Schema.isMinLength(1)),
  SENDBLUE_API_KEY_ID: Schema.String.check(Schema.isMinLength(1)),
  SENDBLUE_API_SECRET_KEY: Schema.String.check(Schema.isMinLength(1)),
  SENDBLUE_WEBHOOK_SIGNING_SECRET: Schema.String.check(Schema.isMinLength(32)),
  SENDBLUE_FROM_NUMBER: Schema.String.check(Schema.isPattern(/^\+[1-9]\d{7,14}$/)),
  SENDBLUE_ALLOWED_USER_NUMBER: Schema.String.check(Schema.isPattern(/^\+[1-9]\d{7,14}$/)),
  SENDBLUE_STATUS_CALLBACK_URL: Schema.URLFromString,
  BOB_RELEASE_SHA: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/))
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
  const config = Schema.decodeUnknownSync(Environment)(process.env)
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
  const commonTelemetry = {
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318",
    OTEL_ACCESS_CLIENT_ID: "disabled",
    OTEL_ACCESS_CLIENT_SECRET: "disabled",
    BOB_RELEASE_SHA: config.BOB_RELEASE_SHA
  }
  const ingressBindings: IngressBindings = {
    CORE: core,
    INBOUND_QUEUE: inboundQueueBinding,
    SENDBLUE_ACCOUNT_ID: config.SENDBLUE_ACCOUNT_ID,
    SENDBLUE_LINE_ID: config.SENDBLUE_LINE_ID,
    SENDBLUE_WEBHOOK_SIGNING_SECRET: config.SENDBLUE_WEBHOOK_SIGNING_SECRET,
    SENDBLUE_FROM_NUMBER: config.SENDBLUE_FROM_NUMBER,
    SENDBLUE_ALLOWED_USER_NUMBER: config.SENDBLUE_ALLOWED_USER_NUMBER,
    CORE_CALLER_SECRET: config.CORE_CALLER_SECRET,
    ...commonTelemetry
  }
  const egressBindings: EgressBindings = {
    CORE: core,
    INGRESS: makeHttpFetcher("http://127.0.0.1:8786"),
    DELIVERY_RESULT_QUEUE: deliveryResultQueueBinding,
    SENDBLUE_API_KEY_ID: config.SENDBLUE_API_KEY_ID,
    SENDBLUE_API_SECRET_KEY: config.SENDBLUE_API_SECRET_KEY,
    SENDBLUE_WEBHOOK_SIGNING_SECRET: config.SENDBLUE_WEBHOOK_SIGNING_SECRET,
    SENDBLUE_FROM_NUMBER: config.SENDBLUE_FROM_NUMBER,
    SENDBLUE_ALLOWED_USER_NUMBER: config.SENDBLUE_ALLOWED_USER_NUMBER,
    SENDBLUE_STATUS_CALLBACK_URL: config.SENDBLUE_STATUS_CALLBACK_URL.toString(),
    CORE_CALLER_SECRET: config.CORE_CALLER_SECRET,
    ...commonTelemetry
  }
  const workers = startBullMqWorkerHost(
    [
      {
        queueName: "bob-outbound",
        processor: decodeJobProcessor(
          { decode: (input) => Schema.decodeUnknownSync(OutboundJob)(input) },
          {
            process: async (job) =>
              (await processOutboundJob(job, egressBindings)) === "done"
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
            ? await egressWorker.fetch(request, egressBindings)
            : await handleIngressHttp(request, ingressBindings)
      await writeWebResponse(response, outgoing)
    } catch {
      outgoing.writeHead(500).end()
    }
  })
  server.listen(config.PORT, "0.0.0.0")

  async function shutdown(): Promise<void> {
    server.close()
    await workers.close()
    await Promise.all([inboundQueue.close(), deliveryResultQueue.close()])
  }
  process.once("SIGTERM", () => void shutdown())
  process.once("SIGINT", () => void shutdown())
}

void main().catch((error: Error) => {
  console.error(JSON.stringify({ service: "channel-runtime", error: error.message }))
  process.exitCode = 1
})
