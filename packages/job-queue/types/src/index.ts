export interface PublishJobOptions {
  /** Do not make the job available before this delay has elapsed. */
  readonly delayMs?: number
}

/**
 * The provider-neutral Interface for durable job publication.
 *
 * A resolved promise means that the Adapter accepted the job. It does not mean
 * that a worker completed the job. A rejected promise has an unknown enqueue
 * outcome, so callers must rely on durable idempotency before they retry.
 */
export interface JobPublisher<Job> {
  readonly publish: (job: Job, options?: PublishJobOptions) => Promise<void>
}

export type JobDisposition =
  | { readonly state: "complete" }
  | { readonly state: "retry"; readonly delayMs: number }

export interface JobProcessor<Job> {
  readonly process: (job: Job) => Promise<JobDisposition>
}

export type JobPayload =
  | null
  | boolean
  | number
  | string
  | readonly JobPayload[]
  | { readonly [key: string]: JobPayload }

export interface JobConsumerRoute {
  readonly queueName: string
  readonly processor: JobProcessor<JobPayload>
  readonly concurrency?: number
  readonly unexpectedErrorDelayMs?: number
}

export interface JobDecoder<Job> {
  readonly decode: (input: JobPayload) => Job
}

export const completeJob: JobDisposition = { state: "complete" }

export function retryJob(delayMs: number): JobDisposition {
  return { state: "retry", delayMs: validatedDelayMs({ delayMs }) ?? 0 }
}

export function decodeJobProcessor<Job>(
  decoder: JobDecoder<Job>,
  processor: JobProcessor<Job>,
  invalidDisposition: JobDisposition
): JobProcessor<JobPayload> {
  return {
    process(input: JobPayload): Promise<JobDisposition> {
      try {
        return processor.process(decoder.decode(input))
      } catch {
        return Promise.resolve(invalidDisposition)
      }
    }
  }
}

export function validatedDelayMs(options?: PublishJobOptions): number | undefined {
  const delayMs = options?.delayMs
  if (delayMs === undefined) return undefined
  if (!Number.isSafeInteger(delayMs) || delayMs < 0) {
    throw new RangeError("Job delay must be a non-negative safe integer")
  }
  return delayMs
}
