import { readFile } from "node:fs/promises"

const bundle = await readFile(new URL("../apps/agent/dist/index.cjs", import.meta.url), "utf8")

for (const required of [
  "bundledLoaders = loaders",
  "openaiCodex: () => openaiCodexOAuth",
  "function registerBunOAuthFlows()",
  "registerBunOAuthFlows();"
]) {
  if (!bundle.includes(required)) {
    throw new Error(`Agent bundle is missing the static OAuth marker: ${required}`)
  }
}
