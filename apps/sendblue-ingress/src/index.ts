import type { IngressBindings } from "./bindings.ts"

import { handleIngressHttp } from "./entrypoints/http.ts"

export default {
  fetch(request: Request, bindings: IngressBindings, context: ExecutionContext): Promise<Response> {
    return handleIngressHttp(request, bindings, context)
  }
} satisfies ExportedHandler<IngressBindings>
