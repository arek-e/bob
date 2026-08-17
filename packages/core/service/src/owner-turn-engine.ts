import type {
  ConversationTurnSnapshot,
  OfferedConversationTurn
} from "@bob/conversations-types/turn-store"
import type { InboundJob } from "@bob/core-types/jobs"

import { ConversationTurnStore } from "@bob/conversations-types/turn-store"
import { Effect } from "effect"

export interface OwnerTurnEngineDependencies {
  readonly schedule: (at: Date) => Promise<void>
  readonly process: (snapshot: ConversationTurnSnapshot) => Promise<void>
  readonly steer: (
    runId: string,
    correlationId: string,
    traceparent: string | undefined,
    turn: { readonly turnId: string; readonly revision: number }
  ) => Promise<"aborted_model" | "queued" | "missing" | "unavailable">
}

export interface OwnerTurnEngine {
  readonly accept: (
    job: InboundJob,
    correlationId: string,
    traceparent?: string
  ) => Effect.Effect<OfferedConversationTurn, unknown, ConversationTurnStore>
  readonly wake: () => Effect.Effect<void, unknown, ConversationTurnStore>
}

const fromPromise = <Value>(operation: () => Promise<Value>) =>
  Effect.tryPromise({ try: operation, catch: (cause) => cause })

export function makeOwnerTurnEngine(dependencies: OwnerTurnEngineDependencies): OwnerTurnEngine {
  return {
    accept: Effect.fnUntraced(function* (job, correlationId, traceparent) {
      const turns = yield* ConversationTurnStore
      const offered = yield* turns.offer(job.eventId, traceparent)
      yield* fromPromise(() => dependencies.schedule(new Date(offered.quietUntil)))
      if (!offered.appended || offered.activeRunId === undefined) return offered

      const settling = yield* turns.markSettling(
        offered.turnId,
        offered.revision,
        offered.activeRunId
      )
      if (settling === undefined) return offered
      yield* fromPromise(() => dependencies.schedule(new Date(settling.claimExpiresAt)))
      yield* fromPromise(() =>
        dependencies.steer(offered.activeRunId!, correlationId, traceparent, {
          turnId: offered.turnId,
          revision: offered.revision
        })
      )
      return offered
    }),

    wake: Effect.fnUntraced(function* () {
      const turns = yield* ConversationTurnStore
      while (true) {
        const ready = yield* turns.claimReady()
        if (ready === undefined) break
        yield* fromPromise(() => dependencies.schedule(new Date(ready.claimExpiresAt)))
        yield* fromPromise(() => dependencies.process(ready))
      }
      const nextWakeAt = yield* turns.nextWakeAt()
      if (nextWakeAt !== undefined) {
        yield* fromPromise(() => dependencies.schedule(new Date(nextWakeAt)))
      }
    })
  }
}
