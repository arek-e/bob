import type { HttpRouteContext } from "../../context.ts"

import { handleInternalAgent } from "./agent.ts"
import { handleInternalConversations } from "./conversations.ts"
import { handleInternalDelivery } from "./delivery.ts"
import { handleInternalOperations } from "./operations.ts"

export async function handleInternalRequest(
  context: HttpRouteContext
): Promise<Response | undefined> {
  const operations = await handleInternalOperations(context)
  if (operations !== undefined) return operations

  const conversations = await handleInternalConversations(context)
  if (conversations !== undefined) return conversations

  const delivery = await handleInternalDelivery(context)
  if (delivery !== undefined) return delivery

  return handleInternalAgent(context)
}
