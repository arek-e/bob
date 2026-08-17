import type { AgentRunContinuationJob, AgentRunJob } from "@bob/agent-runs-types/worker-gateway"
import type { CoreDatabase } from "@bob/db-types"
import type { JobPublisher } from "@bob/job-queue-types"

import { agentRunOutbox, agentRuns } from "@bob/db-service/schema/conversations"
import { and, asc, eq, lte } from "drizzle-orm"
import { Effect } from "effect"

export interface AgentRunQueueProvider {
  readonly forExecutionPool: (executionPoolId: string) => JobPublisher<AgentRunJob>
}

export interface AgentRunDispatchResult {
  readonly selected: number
  readonly published: number
  readonly failed: number
}

export interface AgentRunDispatcher {
  readonly dispatchPending: (limit?: number) => Promise<AgentRunDispatchResult>
}

export interface AgentRunContinuationDispatcher {
  readonly dispatchPending: (limit?: number) => Promise<AgentRunDispatchResult>
}

export function makeAgentRunDispatcher(
  database: CoreDatabase,
  queues: AgentRunQueueProvider,
  options: { readonly now?: () => Date } = {}
): AgentRunDispatcher {
  const now = options.now ?? (() => new Date())

  return {
    async dispatchPending(limit = 100) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
        throw new RangeError("Agent Run dispatch limit must be between 1 and 1000")
      }
      const selectedAt = now().toISOString()
      const rows = await Effect.runPromise(
        database
          .select({
            outboxId: agentRunOutbox.id,
            runId: agentRunOutbox.runId,
            generation: agentRunOutbox.generation,
            executionPoolId: agentRuns.executionPoolId,
            jobProtocolVersion: agentRuns.jobProtocolVersion
          })
          .from(agentRunOutbox)
          .innerJoin(agentRuns, eq(agentRunOutbox.runId, agentRuns.id))
          .where(
            and(
              eq(agentRunOutbox.kind, "dispatch"),
              eq(agentRunOutbox.state, "pending"),
              lte(agentRunOutbox.availableAt, selectedAt)
            )
          )
          .orderBy(asc(agentRunOutbox.availableAt), asc(agentRunOutbox.id))
          .limit(limit)
      )

      let published = 0
      let failed = 0
      for (const row of rows) {
        if (row.executionPoolId === null || row.jobProtocolVersion !== 1) {
          failed += 1
          await Effect.runPromise(
            database
              .update(agentRunOutbox)
              .set({ state: "failed", failureCount: 1 })
              .where(and(eq(agentRunOutbox.id, row.outboxId), eq(agentRunOutbox.state, "pending")))
          )
          continue
        }
        const job: AgentRunJob = {
          wireVersion: 1,
          runId: row.runId,
          dispatchGeneration: row.generation,
          executionPoolId: row.executionPoolId
        }
        try {
          await queues.forExecutionPool(row.executionPoolId).publish(job, {
            deduplicationKey: `agent-run-${row.runId}-${row.generation}`
          })
          const publishedAt = now().toISOString()
          await Effect.runPromise(
            database.transaction(() =>
              Effect.gen(function* () {
                const marked = yield* database
                  .update(agentRunOutbox)
                  .set({ state: "published", publishedAt })
                  .where(
                    and(eq(agentRunOutbox.id, row.outboxId), eq(agentRunOutbox.state, "pending"))
                  )
                  .returning({ id: agentRunOutbox.id })
                if (marked.length === 0) return
                yield* database
                  .update(agentRuns)
                  .set({ status: "queued" })
                  .where(and(eq(agentRuns.id, row.runId), eq(agentRuns.status, "accepted")))
              })
            )
          )
          published += 1
        } catch {
          failed += 1
        }
      }
      return { selected: rows.length, published, failed }
    }
  }
}

export function makeAgentRunContinuationDispatcher(
  database: CoreDatabase,
  publisher: JobPublisher<AgentRunContinuationJob>,
  options: { readonly now?: () => Date } = {}
): AgentRunContinuationDispatcher {
  const now = options.now ?? (() => new Date())
  return {
    async dispatchPending(limit = 100) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
        throw new RangeError("Agent Run continuation limit must be between 1 and 1000")
      }
      const selectedAt = now().toISOString()
      const rows = await Effect.runPromise(
        database
          .select({
            outboxId: agentRunOutbox.id,
            runId: agentRunOutbox.runId,
            generation: agentRunOutbox.generation
          })
          .from(agentRunOutbox)
          .where(
            and(
              eq(agentRunOutbox.kind, "continuation"),
              eq(agentRunOutbox.state, "pending"),
              lte(agentRunOutbox.availableAt, selectedAt)
            )
          )
          .orderBy(asc(agentRunOutbox.availableAt), asc(agentRunOutbox.id))
          .limit(limit)
      )
      let published = 0
      let failed = 0
      for (const row of rows) {
        try {
          await publisher.publish(
            { wireVersion: 1, runId: row.runId, generation: row.generation },
            { deduplicationKey: `agent-continuation-${row.runId}-${row.generation}` }
          )
          await Effect.runPromise(
            database
              .update(agentRunOutbox)
              .set({ state: "published", publishedAt: now().toISOString() })
              .where(and(eq(agentRunOutbox.id, row.outboxId), eq(agentRunOutbox.state, "pending")))
          )
          published += 1
        } catch {
          failed += 1
        }
      }
      return { selected: rows.length, published, failed }
    }
  }
}
