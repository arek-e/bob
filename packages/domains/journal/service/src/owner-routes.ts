import type { OwnerRouteModule } from "@bob/core-types/runtime-module"

import { JournalEntryCreate, JournalEntryUpdate } from "@bob/journal-types/ui"
import { Schema } from "effect"

import type { JournalStore } from "./store.ts"

export function makeJournalOwnerRoutes(journal: JournalStore): OwnerRouteModule {
  return {
    id: "journal-owner-routes",
    async handle(context) {
      const { request, url, ownerId } = context
      if (request.method === "POST" && url.pathname === "/api/journal/handoffs") {
        const handoff = await journal.createHandoff(ownerId, 10 * 60_000, context.idempotencyKey())
        return {
          body: {
            id: handoff.id,
            expiresAt: handoff.expiresAt,
            path: `/journal/${handoff.id}`,
            bearerToken: false
          }
        }
      }
      if (url.pathname === "/api/journal") {
        if (request.method === "GET") {
          return {
            body: {
              entries: await journal.searchMetadata(
                ownerId,
                url.searchParams.get("tag") ?? undefined
              )
            }
          }
        }
        if (request.method === "POST") {
          const input = Schema.decodeUnknownSync(JournalEntryCreate)(await context.readJson())
          const entry =
            input.approvedSummary === undefined
              ? { ownerId, handoffId: input.handoffId, text: input.text, tags: input.tags }
              : {
                  ownerId,
                  handoffId: input.handoffId,
                  text: input.text,
                  tags: input.tags,
                  approvedSummary: input.approvedSummary
                }
          return {
            body: { id: await journal.createEntry(entry, context.idempotencyKey()) },
            status: 201
          }
        }
      }
      const entryMatch = url.pathname.match(/^\/api\/journal\/([^/]+)$/)
      if (entryMatch === null) return undefined
      const entryId = decodeURIComponent(entryMatch[1]!)
      if (request.method === "GET") {
        const entry = await journal.readEntry(ownerId, entryId)
        return entry === undefined ? { body: { code: "not_found" }, status: 404 } : { body: entry }
      }
      if (request.method === "PUT") {
        const input = Schema.decodeUnknownSync(JournalEntryUpdate)(await context.readJson())
        await journal.updateEntry(ownerId, entryId, input, context.idempotencyKey())
        return { body: { ok: true } }
      }
      if (request.method === "DELETE") {
        await journal.deleteEntry(ownerId, entryId, context.idempotencyKey())
        return { body: { ok: true } }
      }
      return undefined
    }
  }
}
