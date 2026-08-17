import type { JobProcessor, JobPublisher, PublishJobOptions } from "@bob/job-queue-types"

import { validatedDeduplicationKey, validatedDelayMs } from "@bob/job-queue-types"

export interface BullMqQueueAdapterInput<Job, Result> {
  readonly add: (
    name: string,
    job: Job,
    options?: { readonly delay?: number; readonly jobId?: string }
  ) => Promise<Result>
}

export interface BullMqJobAdapterInput<Job> {
  readonly data: Job
  readonly moveToDelayed: (timestamp: number, token?: string) => Promise<void>
}

export interface BullMqJobConsumerOptions {
  readonly makeDelayedError: () => Error
  readonly now?: () => number
  readonly unexpectedErrorDelayMs?: number
  readonly onUnexpectedError?: (error: Error) => void
}

export function makeBullMqJobPublisher<Job, Result>(
  queue: BullMqQueueAdapterInput<Job, Result>,
  jobName: string
): JobPublisher<Job> {
  if (jobName.trim().length === 0) throw new TypeError("BullMQ job name must not be empty")
  return {
    async publish(job: Job, options?: PublishJobOptions): Promise<void> {
      const delayMs = validatedDelayMs(options)
      const jobId = validatedDeduplicationKey(options)
      if (delayMs === undefined) {
        if (jobId === undefined) await queue.add(jobName, job)
        else await queue.add(jobName, job, { jobId })
      } else if (jobId === undefined) {
        await queue.add(jobName, job, { delay: delayMs })
      } else {
        await queue.add(jobName, job, { delay: delayMs, jobId })
      }
    }
  }
}

export function makeBullMqJobProcessor<Job>(
  processor: JobProcessor<Job>,
  options: BullMqJobConsumerOptions
): (job: BullMqJobAdapterInput<Job>, token?: string) => Promise<void> {
  const now = options.now ?? Date.now
  return async (job, token) => {
    let disposition
    try {
      disposition = await processor.process(job.data)
    } catch (error) {
      options.onUnexpectedError?.(
        error instanceof Error ? error : new Error("Unknown job processor failure")
      )
      if (options.unexpectedErrorDelayMs === undefined) throw error
      const delayMs = validatedDelayMs({ delayMs: options.unexpectedErrorDelayMs })
      if (delayMs === undefined) throw new TypeError("Unexpected error delay is missing")
      await job.moveToDelayed(now() + delayMs, token)
      throw options.makeDelayedError()
    }
    if (disposition.state === "complete") return
    await job.moveToDelayed(now() + disposition.delayMs, token)
    throw options.makeDelayedError()
  }
}
