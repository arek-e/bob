import * as Cloudflare from "alchemy/Cloudflare"

import { createEvalStorageStack } from "./src/eval-storage-stack.ts"

export default createEvalStorageStack({
  providers: Cloudflare.providers(),
  state: Cloudflare.state()
})
