import type { JobDisposition, JobProcessor, JobPublisher, PublishJobOptions } from "./index.ts"

import { validatedDelayMs } from "./index.ts"

export interface CloudflareQueueAdapterInput<Job, Result> {
  readonly send: (job: Job, options?: { readonly delaySeconds?: number }) => Promise<Result>
}

export interface CloudflareMessageAdapterInput<Job> {
  readonly body: Job
  readonly ack: () => void
  readonly retry: (options?: { readonly delaySeconds?: number }) => void
}

export interface CloudflareJobConsumerOptions {
  readonly unexpectedErrorDelayMs: number
}

export function makeCloudflareJobPublisher<Job, Result>(
  queue: CloudflareQueueAdapterInput<Job, Result>
): JobPublisher<Job> {
  return {
    async publish(job: Job, options?: PublishJobOptions): Promise<void> {
      const delayMs = validatedDelayMs(options)
      if (delayMs === undefined || delayMs === 0) {
        await queue.send(job)
        return
      }
      await queue.send(job, { delaySeconds: Math.ceil(delayMs / 1_000) })
    }
  }
}

function retryDelaySeconds(disposition: Extract<JobDisposition, { readonly state: "retry" }>) {
  return Math.ceil(disposition.delayMs / 1_000)
}

export async function processCloudflareMessage<Job>(
  message: CloudflareMessageAdapterInput<Job>,
  processor: JobProcessor<Job>,
  options: CloudflareJobConsumerOptions
): Promise<JobDisposition> {
  let disposition: JobDisposition
  try {
    disposition = await processor.process(message.body)
  } catch {
    disposition = {
      state: "retry",
      delayMs: validatedDelayMs({ delayMs: options.unexpectedErrorDelayMs }) ?? 0
    }
  }
  if (disposition.state === "complete") message.ack()
  else message.retry({ delaySeconds: retryDelaySeconds(disposition) })
  return disposition
}
