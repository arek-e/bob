import type { CoreBindings } from "@bob/core-types/bindings"

import { ownerSession } from "@bob/policy-service/auth/service"
import { authorizeHeadlessApiRequest } from "@bob/policy-service/headless"

import { json } from "./response.ts"

export async function authenticateOwnerApiRequest(
  request: Request,
  url: URL,
  bindings: CoreBindings
): Promise<string | Response> {
  try {
    const supportsMachineAuth =
      request.method === "GET" && url.pathname === "/api/production-data/messages"
    if (supportsMachineAuth && request.headers.has("authorization")) {
      const headlessAccess =
        bindings.BOB_HEADLESS_OWNER_ID === undefined
          ? { apiKey: bindings.BOB_HEADLESS_API_KEY }
          : { apiKey: bindings.BOB_HEADLESS_API_KEY, ownerId: bindings.BOB_HEADLESS_OWNER_ID }
      const principal = await authorizeHeadlessApiRequest(request, headlessAccess)
      if (principal.ownerId === undefined) return json({ code: "owner_scope_required" }, 403)
      return principal.ownerId
    }

    const session = await ownerSession(request, bindings)
    if (session === null) return json({ code: "unauthorized" }, 401)
    return session.user.id
  } catch {
    return json({ code: "unauthorized" }, 401)
  }
}
