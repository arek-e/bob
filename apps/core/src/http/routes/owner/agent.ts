import type { OwnerHttpRouteContext } from "../../context.ts"

import { json } from "../../response.ts"

export async function handleOwnerAgent(
  context: OwnerHttpRouteContext
): Promise<Response | undefined> {
  if (context.request.method === "GET" && context.url.pathname === "/api/agent/status") {
    const response = await fetch(
      `${context.composition.config.AGENT_ADMIN_URL}/v1/admin/auth/status`,
      {
        headers: {
          "x-bob-caller-token": context.composition.config.AGENT_CALLER_SECRET,
          "x-bob-owner-id": context.ownerId
        }
      }
    )
    return json(await response.json(), response.status)
  }

  if (context.request.method === "POST" && context.url.pathname === "/api/agent/device-login") {
    const response = await fetch(
      `${context.composition.config.AGENT_ADMIN_URL}/v1/admin/auth/device-login`,
      {
        method: "POST",
        headers: {
          "x-bob-caller-token": context.composition.config.AGENT_CALLER_SECRET,
          "x-bob-owner-id": context.ownerId
        }
      }
    )
    return json(await response.json(), response.status)
  }

  return undefined
}
