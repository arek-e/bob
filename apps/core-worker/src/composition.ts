import { makeCloudflareJobPublisher } from "@bob/job-queue/cloudflare"
import { makeR2PrivateObjectStore } from "@bob/object-store/cloudflare"
import { cloudflareEventSink } from "@bob/observability/cloudflare"

import type { CoreBindings } from "./bindings.ts"
import type { CoreRuntimeAdapters } from "./runtime/core-runtime.ts"

import { composeGeneralCore } from "./core-composition.ts"
import { createCoreDatabase } from "./database.ts"
import { coreRuntimeProfile } from "./profiles/core.ts"
import { makeCloudflareOwnerRunCoordinator } from "./runtime/owner-run-coordinator.ts"

export const defaultRuntimeProfile = coreRuntimeProfile

export function makeCloudflareCoreRuntime(bindings: CoreBindings): CoreRuntimeAdapters {
  return {
    applicationStorage: createCoreDatabase(bindings.DB),
    channelProviderId: "sendblue",
    events: cloudflareEventSink(),
    jobQueue: Object.freeze({
      inbound: makeCloudflareJobPublisher(bindings.INBOUND_QUEUE),
      outbound: makeCloudflareJobPublisher(bindings.OUTBOUND_QUEUE)
    }),
    objectStorage: makeR2PrivateObjectStore(bindings.PRIVATE_OBJECTS),
    runCoordinator: makeCloudflareOwnerRunCoordinator(bindings.OWNER_RUN_COORDINATOR)
  }
}

export function composeCoreWithRuntime(bindings: CoreBindings, runtime: CoreRuntimeAdapters) {
  return composeGeneralCore(bindings, defaultRuntimeProfile, runtime)
}

export function composeCore(bindings: CoreBindings) {
  return composeCoreWithRuntime(bindings, makeCloudflareCoreRuntime(bindings))
}

export type CoreComposition = ReturnType<typeof composeCore>
