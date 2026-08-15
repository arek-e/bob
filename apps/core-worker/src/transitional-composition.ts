import type { TransitionalBindings } from "./bindings.ts"

import { composeGeneralCore } from "./core-composition.ts"
import { transitionalRuntimeProfile } from "./profiles/transitional.ts"

export function composeTransitional(bindings: TransitionalBindings) {
  const composition = composeGeneralCore(bindings, transitionalRuntimeProfile)
  return {
    ...composition,
    config: { ...composition.config, UI_BASE_URL: bindings.UI_BASE_URL },
    services: { ...composition.services, ...composition.extensions }
  }
}

export type TransitionalComposition = ReturnType<typeof composeTransitional>
