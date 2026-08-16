import type { CoreDatabase } from "@bob/core-types/database"
import type { InboundJob, OutboundJob } from "@bob/core-types/jobs"
import type { JobPublisher } from "@bob/job-queue-types"
import type { PrivateObjectStore } from "@bob/object-store-types"
import type { EventSink } from "@bob/observability/events"

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

export interface CoreJobQueue {
  readonly inbound: JobPublisher<InboundJob>
  readonly outbound: JobPublisher<OutboundJob>
}

export interface CoreRuntimeAdapters {
  readonly applicationStorage: CoreDatabase
  readonly channelProviderId: string
  readonly events: EventSink
  readonly jobQueue: CoreJobQueue
  readonly objectStorage: PrivateObjectStore
  readonly runCoordinator: OwnerRunCoordinator
}
