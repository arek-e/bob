import * as Cloudflare from "alchemy/Cloudflare"

import { createBobStack } from "./src/bob-stack.ts"
import { ENV } from "./src/environment.generated.ts"

export default createBobStack({
  config: ENV,
  providers: Cloudflare.providers(),
  state: Cloudflare.state()
})
