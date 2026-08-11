import type { IngressBindings } from "./bindings.ts"
import { handleIngressHttp } from "./entrypoints/http.ts"

export default {
  fetch(request: Request, bindings: IngressBindings): Promise<Response> {
    return handleIngressHttp(request, bindings)
  }
} satisfies ExportedHandler<IngressBindings>
