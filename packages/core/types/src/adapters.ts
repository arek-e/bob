import type { CoreDatabase } from "@bob/db-types"
import type { JobPublisher } from "@bob/job-queue-types"
import type { ObjectStorage } from "@bob/object-store-types"
import type { Layer } from "effect"

import type { InboundJob, OutboundJob } from "./jobs.ts"

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

export interface CoreAdapters {
  readonly applicationStorage: CoreDatabase
  readonly channelProviderId: string
  readonly jobQueue: CoreJobQueue
  readonly objectStorage: Layer.Layer<ObjectStorage>
  readonly runCoordinator: OwnerRunCoordinator
}
