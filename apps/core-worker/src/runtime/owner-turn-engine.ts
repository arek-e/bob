import type { InboundJob } from "@bob/contracts/jobs"

import type {
  ConversationTurnSnapshot,
  ConversationTurnStore,
  OfferedConversationTurn
} from "../modules/conversations/turn-store.ts"

export interface OwnerTurnEngineDependencies {
  readonly turns: ConversationTurnStore
  readonly serialize: <Value>(operation: () => Promise<Value>) => Promise<Value>
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
  ) => Promise<OfferedConversationTurn>
  readonly wake: () => Promise<void>
}

export function makeOwnerTurnEngine(dependencies: OwnerTurnEngineDependencies): OwnerTurnEngine {
  return {
    async accept(job, correlationId, traceparent) {
      const offered = await dependencies.serialize(() =>
        dependencies.turns.offer(job.eventId, traceparent)
      )
      await dependencies.schedule(new Date(offered.quietUntil))
      if (!offered.appended || offered.activeRunId === undefined) return offered

      const settling = await dependencies.turns.markSettling(
        offered.turnId,
        offered.revision,
        offered.activeRunId
      )
      if (!settling) return offered
      await dependencies.schedule(new Date(settling.claimExpiresAt))
      await dependencies.steer(offered.activeRunId, correlationId, traceparent, {
        turnId: offered.turnId,
        revision: offered.revision
      })
      return offered
    },

    async wake() {
      while (true) {
        const ready = await dependencies.serialize(() => dependencies.turns.claimReady())
        if (ready === undefined) break
        await dependencies.schedule(new Date(ready.claimExpiresAt))
        await dependencies.process(ready)
      }
      const nextWakeAt = await dependencies.turns.nextWakeAt()
      if (nextWakeAt !== undefined) await dependencies.schedule(new Date(nextWakeAt))
    }
  }
}
