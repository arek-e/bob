import type { CoreAdapters } from "@bob/core-types/adapters"
import type { CoreBindings } from "@bob/core-types/bindings"
import type { Telemetry } from "@bob/observability"

import { composeGeneralCore } from "@bob/core-service/composition"
import { noopTelemetryLayer } from "@bob/observability"
import { Layer, ManagedRuntime } from "effect"

import { coreRuntimeProfile } from "./profiles/core.ts"

export const defaultRuntimeProfile = coreRuntimeProfile

export function composeCore(
  bindings: CoreBindings,
  runtime: CoreAdapters,
  telemetry: Layer.Layer<Telemetry> = noopTelemetryLayer
) {
  const composition = composeGeneralCore(bindings, defaultRuntimeProfile, runtime)
  const layer = Layer.merge(composition.layer, telemetry)
  const managedRuntime = ManagedRuntime.make(layer)
  return {
    ...composition,
    layer,
    runtime: managedRuntime
  }
}

export type CoreComposition = ReturnType<typeof composeCore>
export type CoreComposer = (bindings: CoreBindings) => CoreComposition
export type CoreRuntimeRequirements = ManagedRuntime.ManagedRuntime.Services<
  CoreComposition["runtime"]
>
