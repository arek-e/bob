import type { ConnectionOptions, Job, WorkerOptions } from "bullmq"

import { DelayedError, Worker } from "bullmq"

import type { JobConsumerRoute } from "./index.ts"

import { makeBullMqJobProcessor } from "./bullmq.ts"

export interface BullMqWorkerLike {
  readonly waitUntilReady: () => Promise<void>
  readonly close: () => Promise<void>
  readonly isRunning: () => boolean
}

export interface BullMqWorkerFactory {
  readonly create: <JobData>(
    queueName: string,
    processor: (job: Job<JobData>, token?: string) => Promise<void>,
    options: WorkerOptions
  ) => BullMqWorkerLike
}

export interface BullMqWorkerHostOptions {
  readonly connection: ConnectionOptions
  readonly prefix?: string
  readonly workerFactory?: BullMqWorkerFactory
  readonly onUnexpectedError?: (queueName: string, error: Error) => void
}

export interface BullMqWorkerHost {
  readonly queueNames: readonly string[]
  readonly ready: () => Promise<void>
  readonly healthy: () => boolean
  readonly close: () => Promise<void>
}

const defaultWorkerFactory: BullMqWorkerFactory = {
  create<JobData>(
    queueName: string,
    processor: (job: Job<JobData>, token?: string) => Promise<void>,
    options: WorkerOptions
  ) {
    const worker = new Worker<JobData>(queueName, processor, options)
    return {
      async waitUntilReady(): Promise<void> {
        await worker.waitUntilReady()
      },
      close: () => worker.close(),
      isRunning: () => worker.isRunning()
    }
  }
}

function validateRoutes(routes: readonly JobConsumerRoute[]): void {
  const names = new Set<string>()
  for (const route of routes) {
    const queueName = route.queueName.trim()
    if (queueName.length === 0) throw new TypeError("BullMQ queue name must not be empty")
    if (names.has(queueName)) throw new TypeError(`Duplicate BullMQ queue route: ${queueName}`)
    if (
      route.concurrency !== undefined &&
      (!Number.isSafeInteger(route.concurrency) || route.concurrency < 1)
    ) {
      throw new RangeError(`BullMQ concurrency must be a positive safe integer: ${queueName}`)
    }
    names.add(queueName)
  }
}

export function startBullMqWorkerHost(
  routes: readonly JobConsumerRoute[],
  options: BullMqWorkerHostOptions
): BullMqWorkerHost {
  validateRoutes(routes)
  const factory = options.workerFactory ?? defaultWorkerFactory
  const workers = routes.map((route) => {
    const process = makeBullMqJobProcessor(route.processor, {
      makeDelayedError: () => new DelayedError(),
      unexpectedErrorDelayMs: route.unexpectedErrorDelayMs ?? 30_000,
      onUnexpectedError: (error) => options.onUnexpectedError?.(route.queueName, error)
    })
    const workerOptions: WorkerOptions = { connection: options.connection }
    if (options.prefix !== undefined) workerOptions.prefix = options.prefix
    if (route.concurrency !== undefined) workerOptions.concurrency = route.concurrency
    return factory.create(route.queueName, process, workerOptions)
  })
  let closed = false

  return {
    queueNames: Object.freeze(routes.map((route) => route.queueName)),
    async ready(): Promise<void> {
      await Promise.all(workers.map((worker) => worker.waitUntilReady()))
    },
    healthy(): boolean {
      return !closed && workers.every((worker) => worker.isRunning())
    },
    async close(): Promise<void> {
      if (closed) return
      closed = true
      await Promise.all(workers.map((worker) => worker.close()))
    }
  }
}
