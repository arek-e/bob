import * as Alchemy from "alchemy"

import { createEvalStorageStack } from "./src/eval-storage-stack.ts"
import { smokeProviders } from "./src/smoke-providers.ts"

export default createEvalStorageStack({
  name: "bob-evals-alchemy-compatibility",
  providers: smokeProviders(),
  state: Alchemy.inMemoryState()
})
