import type { EgressBindings } from "./bindings.ts"

import { handleInteractionRequest } from "./entrypoints/http.ts"
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
    return new Response(null, { status: 404 })
  },
  queue(
    batch: MessageBatch<unknown>,
    bindings: EgressBindings,
    context: ExecutionContext
  ): Promise<void> {
    return handleOutboundQueue(batch, bindings, context)
  }
} satisfies ExportedHandler<EgressBindings>
