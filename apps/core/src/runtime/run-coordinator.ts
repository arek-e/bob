import type {
  CoreAdapters,
  OwnerRunCoordinator,
  OwnerRunRequest,
  OwnerWakeRequest
} from "@bob/core-types/adapters"
import type { OwnerWakeJob } from "@bob/core-types/jobs"
import type { JobProcessor, JobPublisher } from "@bob/job-queue-types"

import { ownerWakeOutbox } from "@bob/db-service/schema/conversations"
import { completeJob } from "@bob/job-queue-types"
import { and, eq, ne } from "drizzle-orm"
import { Effect } from "effect"

export function makeHandlerOwnerRunCoordinator(input: {
  readonly run: (request: OwnerRunRequest) => Promise<Response>
  readonly wake: (request: OwnerWakeRequest) => Promise<void>
}): OwnerRunCoordinator {
  return Object.freeze({ run: input.run, wake: input.wake })
}

export interface OwnerWakeOutboxPort {
  readonly create: (input: {
    readonly id: string
    readonly ownerId: string
    readonly requestedAt: string
    readonly createdAt: string
  }) => Promise<void>
  readonly markPublished: (wakeId: string, publishedAt: string) => Promise<void>
  readonly markCompleted: (wakeId: string, completedAt: string) => Promise<void>
  readonly incomplete: () => Promise<
    ReadonlyArray<{ readonly id: string; readonly ownerId: string; readonly requestedAt: string }>
  >
}

export function makePostgresqlOwnerWakeOutbox(
  database: CoreAdapters["applicationStorage"]
): OwnerWakeOutboxPort {
  return {
    async create(input) {
      await Effect.runPromise(
        database.insert(ownerWakeOutbox).values({
          id: input.id,
          userId: input.ownerId,
          requestedAt: input.requestedAt,
          state: "pending",
          createdAt: input.createdAt
        })
      )
    },
    async markPublished(wakeId, publishedAt) {
      await Effect.runPromise(
        database
          .update(ownerWakeOutbox)
          .set({ state: "published", publishedAt })
          .where(and(eq(ownerWakeOutbox.id, wakeId), ne(ownerWakeOutbox.state, "completed")))
      )
    },
    async markCompleted(wakeId, completedAt) {
      await Effect.runPromise(
        database
          .update(ownerWakeOutbox)
          .set({ state: "completed", completedAt })
          .where(eq(ownerWakeOutbox.id, wakeId))
      )
    },
    async incomplete() {
      return Effect.runPromise(
        database
          .select({
            id: ownerWakeOutbox.id,
            ownerId: ownerWakeOutbox.userId,
            requestedAt: ownerWakeOutbox.requestedAt
          })
          .from(ownerWakeOutbox)
          .where(ne(ownerWakeOutbox.state, "completed"))
          .limit(500)
      )
    }
  }
}

export function makeQueuedOwnerRunCoordinator(input: {
  readonly accept: (request: OwnerRunRequest) => Promise<Response>
  readonly wakeJobs: JobPublisher<OwnerWakeJob>
  readonly wakeOutbox: OwnerWakeOutboxPort
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
      const wakeId = crypto.randomUUID()
      await input.wakeOutbox.create({
        id: wakeId,
        ownerId: request.ownerId,
        requestedAt,
        createdAt: current.toISOString()
      })
      await input.wakeJobs.publish(
        { wakeId, ownerId: request.ownerId, requestedAt },
        {
          delayMs: Math.max(0, target.getTime() - current.getTime()),
          deduplicationKey: wakeId
        }
      )
      await input.wakeOutbox.markPublished(wakeId, new Date().toISOString())
    }
  })
}

export function makeOwnerWakeJobProcessor(input: {
  readonly wake: (job: OwnerWakeJob) => Promise<void>
  readonly complete: (wakeId: string) => Promise<void>
}): JobProcessor<OwnerWakeJob> {
  return {
    async process(job) {
      await input.wake(job)
      await input.complete(job.wakeId)
      return completeJob
    }
  }
}

export async function repairOwnerWakeOutbox(
  wakeOutbox: OwnerWakeOutboxPort,
  wakeJobs: JobPublisher<OwnerWakeJob>,
  now = new Date()
): Promise<void> {
  const pending = await wakeOutbox.incomplete()
  for (const item of pending) {
    const target = new Date(item.requestedAt)
    await wakeJobs.publish(
      { wakeId: item.id, ownerId: item.ownerId, requestedAt: item.requestedAt },
      { delayMs: Math.max(0, target.getTime() - now.getTime()), deduplicationKey: item.id }
    )
    await wakeOutbox.markPublished(item.id, now.toISOString())
  }
}
