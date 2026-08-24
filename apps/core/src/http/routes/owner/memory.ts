import { MemoryStore } from "@bob/memory-types/store"
import { MemoryCandidateCorrection } from "@bob/operations-types/ui"
import { Effect, Schema } from "effect"

import type { OwnerHttpRouteContext } from "../../context.ts"

import { json } from "../../response.ts"

export async function handleOwnerMemory(
  context: OwnerHttpRouteContext
): Promise<Response | undefined> {
  if (context.request.method === "GET" && context.url.pathname === "/api/memory/candidates") {
    return json({
      candidates: await context.composition.runtime.runPromise(
        Effect.flatMap(MemoryStore, (memory) => memory.listCandidates(context.ownerId))
      )
    })
  }

  const confirm = context.url.pathname.match(/^\/api\/memory\/candidates\/([^/]+)\/confirm$/)
  if (context.request.method === "POST" && confirm !== null) {
    const revisionId = await context.composition.runtime.runPromise(
      Effect.flatMap(MemoryStore, (memory) =>
        memory.confirm(
          context.ownerId,
          decodeURIComponent(confirm[1]!),
          "owner_ui",
          context.idempotencyKey()
        )
      )
    )
    return json({ revisionId })
  }

  const correct = context.url.pathname.match(/^\/api\/memory\/candidates\/([^/]+)\/correct$/)
  if (context.request.method === "POST" && correct !== null) {
    const input = Schema.decodeUnknownSync(MemoryCandidateCorrection)(await context.readJson())
    const candidateId = await context.composition.runtime.runPromise(
      Effect.flatMap(MemoryStore, (memory) =>
        memory.correct(
          context.ownerId,
          decodeURIComponent(correct[1]!),
          input.canonicalText,
          context.idempotencyKey()
        )
      )
    )
    return json({ candidateId })
  }

  const reject = context.url.pathname.match(/^\/api\/memory\/candidates\/([^/]+)\/reject$/)
  if (context.request.method === "POST" && reject !== null) {
    await context.composition.runtime.runPromise(
      Effect.flatMap(MemoryStore, (memory) =>
        memory.reject(context.ownerId, decodeURIComponent(reject[1]!), context.idempotencyKey())
      )
    )
    return json({ ok: true })
  }

  return undefined
}
