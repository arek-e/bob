import type { EgressBindings } from "./bindings.ts"

import {
  handleDeliveryReconciliationRequest,
  handleInteractionRequest
} from "./entrypoints/http.ts"
import { handleScheduledReconcile } from "./entrypoints/provider-recovery.ts"
import { handleOutboundQueue } from "./entrypoints/queue.ts"

export default {
  fetch(request: Request, bindings: EgressBindings): Response | Promise<Response> {
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
    return new Response(null, { status: 404 })
  },
  queue(
    batch: MessageBatch<unknown>,
    bindings: EgressBindings,
    context: ExecutionContext
  ): Promise<void> {
    return handleOutboundQueue(batch, bindings, context)
  },
  scheduled(
    controller: ScheduledController,
    bindings: EgressBindings,
    context: ExecutionContext
  ): void {
    context.waitUntil(
      handleScheduledReconcile(new Date(controller.scheduledTime), bindings).then(() => undefined)
    )
  }
} satisfies ExportedHandler<EgressBindings>
