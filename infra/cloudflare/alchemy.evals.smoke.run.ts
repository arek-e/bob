import * as Alchemy from "alchemy"

import { createEvalStorageStack } from "./src/eval-storage-stack.ts"
import { smokeProviders } from "./src/smoke-providers.ts"

export default createEvalStorageStack({
  name: "bob-evals-alchemy-compatibility",
  providers: smokeProviders(),
  releaseSha: "0000000000000000000000000000000000000000",
  state: Alchemy.inMemoryState()
})
