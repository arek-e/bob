import { operationalAlerts } from "@bob/db/schema/alerts"
import { and, desc, eq } from "drizzle-orm"
import { Context, Layer } from "effect"

import type { CoreDatabase } from "../../database.ts"

export interface AlertInput {
  readonly ownerId: string
  readonly code: string
  readonly objectType: string
  readonly objectId: string
  readonly idempotencyKey: string
}

export interface AlertStore {
  record(input: AlertInput): Promise<string>
  list(ownerId: string): Promise<readonly unknown[]>
  get(ownerId: string, alertId: string): Promise<typeof operationalAlerts.$inferSelect | undefined>
  setState(ownerId: string, alertId: string, state: "reconciling" | "resolved"): Promise<void>
}

export const AlertStore = Context.Service<AlertStore>("bob/AlertStore")

export async function recordOperationalAlert(
  database: CoreDatabase,
  input: AlertInput,
  options: { readonly now?: () => Date; readonly randomUuid?: () => string } = {}
): Promise<string> {
  if (input.code.trim().length === 0 || input.code.length > 100) {
    throw new Error("Operational alert code is invalid")
  }
  const existing = await database
    .select({ id: operationalAlerts.id })
    .from(operationalAlerts)
    .where(eq(operationalAlerts.idempotencyKey, input.idempotencyKey))
    .limit(1)
  if (existing[0] !== undefined) return existing[0].id
  const id = (options.randomUuid ?? (() => crypto.randomUUID()))()
  const at = (options.now ?? (() => new Date()))().toISOString()
  await database
    .insert(operationalAlerts)
    .values({
      id,
      userId: input.ownerId,
      code: input.code,
      objectType: input.objectType,
      objectId: input.objectId,
      idempotencyKey: input.idempotencyKey,
      state: "open",
      createdAt: at,
      updatedAt: at
    })
    .onConflictDoNothing()
  const [stored] = await database
    .select({ id: operationalAlerts.id })
    .from(operationalAlerts)
    .where(eq(operationalAlerts.idempotencyKey, input.idempotencyKey))
    .limit(1)
  if (stored === undefined) throw new Error("Operational alert was not stored")
  return stored.id
}

export function makeAlertStore(
  database: CoreDatabase,
  options: { readonly now?: () => Date; readonly randomUuid?: () => string }
): AlertStore {
  const now = options.now ?? (() => new Date())
  return {
    record: (input) => recordOperationalAlert(database, input, options),
    list(ownerId) {
      return database
        .select({
          id: operationalAlerts.id,
          code: operationalAlerts.code,
          objectType: operationalAlerts.objectType,
          objectId: operationalAlerts.objectId,
          state: operationalAlerts.state,
          createdAt: operationalAlerts.createdAt,
          updatedAt: operationalAlerts.updatedAt
        })
        .from(operationalAlerts)
        .where(eq(operationalAlerts.userId, ownerId))
        .orderBy(desc(operationalAlerts.createdAt))
        .limit(100)
    },
    async get(ownerId, alertId) {
      const [row] = await database
        .select()
        .from(operationalAlerts)
        .where(and(eq(operationalAlerts.id, alertId), eq(operationalAlerts.userId, ownerId)))
        .limit(1)
      return row
    },
    async setState(ownerId, alertId, state) {
      const at = now().toISOString()
      await database
        .update(operationalAlerts)
        .set(
          state === "resolved" ? { state, updatedAt: at, resolvedAt: at } : { state, updatedAt: at }
        )
        .where(and(eq(operationalAlerts.id, alertId), eq(operationalAlerts.userId, ownerId)))
    }
  }
}

export function alertStoreLayer(store: AlertStore) {
  return Layer.succeed(AlertStore, store)
}
