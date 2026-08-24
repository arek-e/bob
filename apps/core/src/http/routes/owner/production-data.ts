import { ConversationStore } from "@bob/conversations-types/store"
import { parseProductionDataQuery } from "@bob/operations-types/production-data"
import { Effect } from "effect"

import type { OwnerHttpRouteContext } from "../../context.ts"

import { json } from "../../response.ts"

export async function handleOwnerProductionData(
  context: OwnerHttpRouteContext
): Promise<Response | undefined> {
  if (
    context.request.method !== "GET" ||
    context.url.pathname !== "/api/production-data/messages"
  ) {
    return undefined
  }
  const query = parseProductionDataQuery({
    from: context.url.searchParams.get("from"),
    to: context.url.searchParams.get("to"),
    limit: context.url.searchParams.get("limit")
  })
  return json({
    from: query.from,
    to: query.to,
    messages: await context.runTelemetry(
      Effect.flatMap(ConversationStore, (conversations) =>
        conversations.listMessages(context.ownerId, query)
      )
    )
  })
}
