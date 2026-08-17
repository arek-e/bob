import type { CoreBindings } from "@bob/core-types/bindings"

import { composeGeneralCore } from "./core-composition.ts"

export type CoreComposition = ReturnType<typeof composeGeneralCore>
export type CoreComposer = (bindings: CoreBindings) => CoreComposition
