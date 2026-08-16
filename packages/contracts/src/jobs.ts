import { Schema } from "effect"

import { IsoDateTime, Uuid } from "./shared.ts"

const Traceparent = Schema.String.check(Schema.isPattern(/^00-[0-9a-f]{32}-[0-9a-f]{16}-(00|01)$/))

export const InboundJob = Schema.Struct({
  eventId: Uuid,
  correlationId: Schema.optionalKey(Uuid),
  traceparent: Schema.optionalKey(Traceparent)
})

export const OutboundJob = Schema.Struct({
  outboxId: Uuid,
  correlationId: Schema.optionalKey(Uuid),
  traceparent: Schema.optionalKey(Traceparent)
})

export const SchedulerJob = Schema.Struct({
  schedulerOutboxId: Uuid,
  ownerId: Uuid,
  scheduleRevision: Schema.Int
})

export const OwnerWakeJob = Schema.Struct({
  ownerId: Uuid,
  requestedAt: IsoDateTime
})

export type InboundJob = typeof InboundJob.Type
export type OutboundJob = typeof OutboundJob.Type
export type SchedulerJob = typeof SchedulerJob.Type
export type OwnerWakeJob = typeof OwnerWakeJob.Type
