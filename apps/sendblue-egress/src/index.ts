import type { EgressBindings } from "./bindings.ts"

import { handleOutboundQueue } from "./entrypoints/queue.ts"

export default {
  fetch(request: Request): Response {
    const url = new URL(request.url)
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ healthy: true, service: "sendblue-egress", version: 1 })
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
