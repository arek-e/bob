import { Effect } from "effect"

import {
  handleDeliveryReconciliationRequest,
  handleInteractionRequest,
  handleReconcileRequest
} from "./http.ts"

export function handleEgressHttp(request: Request) {
  const url = new URL(request.url)
  if (request.method === "GET" && url.pathname === "/health") {
    return Effect.succeed(Response.json({ healthy: true, service: "sendblue-egress", version: 1 }))
  }
  if (request.method === "POST" && url.pathname === "/internal/message-interaction") {
    return handleInteractionRequest(request)
  }
  if (request.method === "POST" && url.pathname === "/internal/delivery-reconciliation") {
    return handleDeliveryReconciliationRequest(request)
  }
  if (request.method === "POST" && url.pathname === "/internal/inbound-reconcile") {
    return handleReconcileRequest(request)
  }
  return Effect.succeed(new Response(null, { status: 404 }))
}
