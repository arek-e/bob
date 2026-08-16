import type { InboundJob, OutboundJob } from "@bob/contracts/jobs"
import type { JobPublisher } from "@bob/job-queue"
import type { PrivateObjectStore } from "@bob/object-store"
import type { EventSink } from "@bob/observability/events"

import type { CoreDatabase } from "../database.ts"
import type { OwnerRunCoordinator } from "./owner-run-coordinator.ts"

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
