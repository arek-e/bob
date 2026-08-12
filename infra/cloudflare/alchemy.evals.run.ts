import * as Cloudflare from "alchemy/Cloudflare"

import { ENV } from "./src/environment.generated.ts"
import { createEvalStorageStack } from "./src/eval-storage-stack.ts"

export default createEvalStorageStack({
  providers: Cloudflare.providers(),
  releaseSha: ENV.BOB_RELEASE_SHA,
  state: Cloudflare.state()
})
