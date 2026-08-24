import {
  AgentRunAuthorityLost,
  AgentRunCheckpointConflict,
  AgentRunGatewayUnavailable
} from "@bob/agent-runs-types/worker-gateway"
import { ProductionDataInspectorError } from "@bob/operations-types/production-data"

import { RequestBodyTooLargeError } from "./body.ts"
import { json } from "./response.ts"

export function errorResponse(error: Error): Response {
  if (error instanceof ProductionDataInspectorError) {
    return json({ code: "production_data_unavailable" }, 503)
  }
  if (error instanceof AgentRunAuthorityLost) return json({ code: "authority_lost" }, 409)
  if (error instanceof AgentRunCheckpointConflict) {
    return json({ code: "checkpoint_conflict" }, 409)
  }
  if (error instanceof AgentRunGatewayUnavailable) {
    return json({ code: "gateway_unavailable" }, 503)
  }
  const status = error instanceof RequestBodyTooLargeError ? 413 : 400
  return json({ code: status === 413 ? "body_too_large" : "invalid_request" }, status)
}
