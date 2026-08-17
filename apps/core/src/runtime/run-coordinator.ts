import type {
  OwnerRunCoordinator,
  OwnerRunRequest,
  OwnerWakeRequest
} from "@bob/core-types/adapters"
import type { OwnerWakeJob } from "@bob/core-types/jobs"
import type { JobProcessor, JobPublisher } from "@bob/job-queue-types"

import { completeJob } from "@bob/job-queue-types"

export function makeHandlerOwnerRunCoordinator(input: {
  readonly run: (request: OwnerRunRequest) => Promise<Response>
  readonly wake: (request: OwnerWakeRequest) => Promise<void>
}): OwnerRunCoordinator {
  return Object.freeze({ run: input.run, wake: input.wake })
}

export function makeQueuedOwnerRunCoordinator(input: {
  readonly accept: (request: OwnerRunRequest) => Promise<Response>
  readonly wakeJobs: JobPublisher<OwnerWakeJob>
  readonly now?: () => Date
}): OwnerRunCoordinator {
  const now = input.now ?? (() => new Date())
  return makeHandlerOwnerRunCoordinator({
    run: input.accept,
    async wake(request) {
      const current = now()
      const requestedAt = request.wakeAt ?? current.toISOString()
      const target = new Date(requestedAt)
      if (!Number.isFinite(target.getTime())) throw new TypeError("Owner wake time is invalid")
      await input.wakeJobs.publish(
        { ownerId: request.ownerId, requestedAt },
        { delayMs: Math.max(0, target.getTime() - current.getTime()) }
      )
    }
  })
}

export function makeOwnerWakeJobProcessor(input: {
  readonly wake: (job: OwnerWakeJob) => Promise<void>
}): JobProcessor<OwnerWakeJob> {
  return {
    async process(job) {
      await input.wake(job)
      return completeJob
    }
  }
}
