import { readFile } from "node:fs/promises"

import { assertCoolifyComposeReadiness } from "./validate-coolify-compose.mjs"

const source = await readFile("infra/coolify/compose.yaml", "utf8")
assertCoolifyComposeReadiness(source)
console.log("Coolify deployment readiness checks passed.")
