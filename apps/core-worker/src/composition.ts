import type { CoreBindings } from "./bindings.ts"

import { composeGeneralCore } from "./core-composition.ts"
import { coreRuntimeProfile } from "./profiles/core.ts"

export const defaultRuntimeProfile = coreRuntimeProfile

export function composeCore(bindings: CoreBindings) {
  return composeGeneralCore(bindings, defaultRuntimeProfile)
}

export type CoreComposition = ReturnType<typeof composeCore>
