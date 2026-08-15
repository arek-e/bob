import type { CoreBindings } from "./bindings.ts"

import { composeGeneralCore } from "./core-composition.ts"
import { transitionalRuntimeProfile } from "./profiles/transitional.ts"

export function composeCore(bindings: CoreBindings) {
  const composition = composeGeneralCore(bindings, transitionalRuntimeProfile)
  return {
    ...composition,
    config: { ...composition.config, UI_BASE_URL: bindings.UI_BASE_URL },
    // The transitional entrypoint keeps these aliases for stored test fixtures and the
    // deployed clock. The General Core composition does not expose Vertical stores.
    services: { ...composition.services, ...composition.extensions }
  }
}

export type CoreComposition = ReturnType<typeof composeCore>
