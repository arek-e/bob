import { Schema } from "effect"

import { Uuid } from "./shared.ts"

export const InboundJob = Schema.Struct({
  eventId: Uuid
})

export const OutboundJob = Schema.Struct({
  outboxId: Uuid
})

export const SchedulerJob = Schema.Struct({
  schedulerOutboxId: Uuid,
  ownerId: Uuid,
  scheduleRevision: Schema.Int
})

export type InboundJob = typeof InboundJob.Type
export type OutboundJob = typeof OutboundJob.Type
export type SchedulerJob = typeof SchedulerJob.Type
