import type { CoreBindings } from "@bob/core-types/bindings"

import type { CoreRuntimeAdapters } from "./runtime/core-runtime.ts"

import { composeGeneralCore } from "./core-composition.ts"
import { coreRuntimeProfile } from "./profiles/core.ts"

export const defaultRuntimeProfile = coreRuntimeProfile

export function composeCoreWithRuntime(bindings: CoreBindings, runtime: CoreRuntimeAdapters) {
  return composeGeneralCore(bindings, defaultRuntimeProfile, runtime)
}

export type CoreComposition = ReturnType<typeof composeCoreWithRuntime>
export type CoreComposer = (bindings: CoreBindings) => CoreComposition
