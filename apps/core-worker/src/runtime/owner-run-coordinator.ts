import type { InboundJob, OwnerWakeJob } from "@bob/contracts/jobs"
import type { JobProcessor, JobPublisher } from "@bob/job-queue"

import { completeJob } from "@bob/job-queue"

export interface OwnerRunRequest {
  readonly ownerId: string
  readonly job: InboundJob
  readonly correlationId: string
  readonly traceparent?: string
}

export interface OwnerWakeRequest {
  readonly ownerId: string
  readonly wakeAt?: string
}

export interface OwnerRunCoordinator {
  readonly run: (request: OwnerRunRequest) => Promise<Response>
  readonly wake: (request: OwnerWakeRequest) => Promise<void>
}

export function makeCloudflareOwnerRunCoordinator(
  namespace: DurableObjectNamespace
): OwnerRunCoordinator {
  return {
    run(request: OwnerRunRequest): Promise<Response> {
      const euNamespace = namespace.jurisdiction("eu")
      const coordinator = euNamespace.get(euNamespace.idFromName(request.ownerId))
      const headers = new Headers({
        "content-type": "application/json",
        "x-bob-correlation-id": request.correlationId
      })
      if (request.traceparent !== undefined) headers.set("traceparent", request.traceparent)
      const body =
        request.traceparent === undefined
          ? { ...request.job, correlationId: request.correlationId }
          : {
              ...request.job,
              correlationId: request.correlationId,
              traceparent: request.traceparent
            }
      return coordinator.fetch("https://coordinator.internal/run", {
        method: "POST",
        headers,
        body: JSON.stringify(body)
      })
    },
    async wake(request: OwnerWakeRequest): Promise<void> {
      const euNamespace = namespace.jurisdiction("eu")
      const url = new URL("https://coordinator.internal/wake")
      if (request.wakeAt !== undefined) url.searchParams.set("at", request.wakeAt)
      await euNamespace.get(euNamespace.idFromName(request.ownerId)).fetch(url, { method: "POST" })
    }
  }
}

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
