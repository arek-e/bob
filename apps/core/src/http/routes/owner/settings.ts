import { OwnerSettingsUpdate } from "@bob/settings-types/settings"
import { OwnerSettingsStore } from "@bob/settings-types/store"
import { Effect, Schema } from "effect"

import type { OwnerHttpRouteContext } from "../../context.ts"

import { json } from "../../response.ts"

export async function handleOwnerSettings(
  context: OwnerHttpRouteContext
): Promise<Response | undefined> {
  if (
    (context.request.method !== "GET" && context.request.method !== "PUT") ||
    context.url.pathname !== "/api/settings"
  ) {
    return undefined
  }

  const input =
    context.request.method === "PUT"
      ? Schema.decodeUnknownSync(OwnerSettingsUpdate)(await context.readJson())
      : undefined
  const settings = await context.composition.runtime.runPromise(
    Effect.flatMap(OwnerSettingsStore, (store) =>
      input === undefined
        ? store.get(context.ownerId)
        : store.update(context.ownerId, input, context.idempotencyKey())
    )
  )
  const connections = await context.composition.runtime.runPromise(
    Effect.flatMap(OwnerSettingsStore, (store) => store.connections(context.ownerId))
  )
  return json({ settings, connections })
}
