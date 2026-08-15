import { readFile } from "node:fs/promises"

import { assertDeploymentReadiness } from "./deployment-readiness.mjs"

const [baseImages, runtimeContract, coolifyCompose, agentPolicy] = await Promise.all([
  readFile("infra/coolify/base-images.json", "utf8"),
  readFile("infra/coolify/runtime-contract.json", "utf8"),
  readFile("infra/coolify/compose.yaml", "utf8"),
  readFile("infra/openbao/agent-production-policy.hcl", "utf8")
])

assertDeploymentReadiness({ baseImages, runtimeContract, coolifyCompose, agentPolicy })

process.stdout.write("Deployment readiness checks passed for the Coolify production contract.\n")
