import type { EgressBindings } from "./bindings.ts"

import {
  handleDeliveryReconciliationRequest,
  handleInteractionRequest,
  handleReconcileRequest
} from "./entrypoints/http.ts"

export function handleEgressHttp(
  request: Request,
  bindings: EgressBindings
): Response | Promise<Response> {
  const url = new URL(request.url)
  if (request.method === "GET" && url.pathname === "/health") {
    return Response.json({ healthy: true, service: "sendblue-egress", version: 1 })
  }
  if (request.method === "POST" && url.pathname === "/internal/message-interaction") {
    return handleInteractionRequest(request, bindings)
  }
  if (request.method === "POST" && url.pathname === "/internal/delivery-reconciliation") {
    return handleDeliveryReconciliationRequest(request, bindings)
  }
  if (request.method === "POST" && url.pathname === "/internal/inbound-reconcile") {
    return handleReconcileRequest(request, bindings)
  }
  return new Response(null, { status: 404 })
}
