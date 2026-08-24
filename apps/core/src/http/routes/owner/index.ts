import type { OwnerHttpRouteContext } from "../../context.ts"

import { json } from "../../response.ts"
import { handleOwnerAgent } from "./agent.ts"
import { handleOwnerAlerts } from "./alerts.ts"
import { handleOwnerMemory } from "./memory.ts"
import { handleOwnerProductionData } from "./production-data.ts"
import { handleOwnerSettings } from "./settings.ts"

export async function handleOwnerRequest(
  context: OwnerHttpRouteContext
): Promise<Response | undefined> {
  const productionData = await handleOwnerProductionData(context)
  if (productionData !== undefined) return productionData

  const settings = await handleOwnerSettings(context)
  if (settings !== undefined) return settings

  for (const route of context.composition.modules.ownerRoutes) {
    const result = await route.handle({
      request: context.request,
      url: context.url,
      ownerId: context.ownerId,
      readJson: context.readJson,
      idempotencyKey: context.idempotencyKey
    })
    if (result !== undefined) {
      return json(result.body, result.status)
    }
  }

  const alerts = await handleOwnerAlerts(context)
  if (alerts !== undefined) return alerts

  const memory = await handleOwnerMemory(context)
  if (memory !== undefined) return memory

  return handleOwnerAgent(context)
}
