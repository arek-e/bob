import type { EgressBindings } from "./bindings.ts"

import { handleEgressHttp } from "./entrypoints/http.ts"
import { handleOutboundQueue } from "./entrypoints/queue.ts"

export default {
  fetch(request: Request, bindings: EgressBindings): Promise<Response> {
    return handleEgressHttp(request, bindings)
  },
  queue(
    batch: MessageBatch<unknown>,
    bindings: EgressBindings,
    context: ExecutionContext
  ): Promise<void> {
    return handleOutboundQueue(batch, bindings, context)
  }
} satisfies ExportedHandler<EgressBindings>
