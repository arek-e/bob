import type {
  JobDisposition,
  JobProcessor,
  JobPublisher,
  PublishJobOptions
} from "@bob/job-queue-types"

import { validatedDeduplicationKey, validatedDelayMs } from "@bob/job-queue-types"

export interface QueueBinding<Job, Result = void> {
  readonly send: (job: Job, options?: { readonly delaySeconds?: number }) => Promise<Result>
}

export interface QueueMessage<Job> {
  readonly body: Job
  readonly ack: () => void
  readonly retry: (options?: { readonly delaySeconds?: number }) => void
}

export interface QueueConsumerOptions {
  readonly unexpectedErrorDelayMs: number
}

export function makeQueueBindingJobPublisher<Job, Result>(
  queue: QueueBinding<Job, Result>
): JobPublisher<Job> {
  return {
    async publish(job: Job, options?: PublishJobOptions): Promise<void> {
      if (validatedDeduplicationKey(options) !== undefined) {
        throw new TypeError("This queue binding does not support deduplication keys")
      }
      const delayMs = validatedDelayMs(options)
      if (delayMs === undefined || delayMs === 0) {
        await queue.send(job)
        return
      }
      await queue.send(job, { delaySeconds: Math.ceil(delayMs / 1_000) })
    }
  }
}

export async function processQueueBindingMessage<Job>(
  message: QueueMessage<Job>,
  processor: JobProcessor<Job>,
  options: QueueConsumerOptions
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
  else message.retry({ delaySeconds: Math.ceil(disposition.delayMs / 1_000) })
  return disposition
}
