import { NodeRuntime } from "@effect/platform-node"
import { createServer } from "node:http"

import { composeAgent } from "./composition.ts"
import { handleAgentHttp } from "./http.ts"
import { AGENT_LISTEN_HOST } from "./listener.ts"
import { createNodeHttpHandler } from "./node-http.ts"
import { serveAgent } from "./server.ts"

const composition = composeAgent(process.env)
const server = createServer(
  createNodeHttpHandler((request) => handleAgentHttp(request, composition))
)

const main = serveAgent(server, {
  port: composition.config.port,
  host: AGENT_LISTEN_HOST,
  disposeRuntime: composition.runtime.disposeEffect
})

NodeRuntime.runMain(main)
