import type { CoreBindings } from "@bob/core-types/bindings"
import type { RouteJson } from "@bob/core-types/runtime-module"
import type { Effect } from "effect"

import type { CoreComposition, CoreRuntimeRequirements } from "../composition.ts"

export type CoreJobQueue = NonNullable<CoreComposition["jobQueue"]>

export type RunTelemetry = <A, E, R extends CoreRuntimeRequirements>(
  effect: Effect.Effect<A, E, R>
) => Promise<A>

export interface HttpRouteContext {
  readonly request: Request
  readonly url: URL
  readonly bindings: CoreBindings
  readonly composition: CoreComposition
  readonly runTelemetry: RunTelemetry
  readonly jobQueue: () => CoreJobQueue
  readonly readJson: () => Promise<RouteJson>
  readonly readAttachmentBytes: () => Promise<Uint8Array>
  readonly idempotencyKey: () => string
}

export interface OwnerHttpRouteContext extends HttpRouteContext {
  readonly ownerId: string
}
