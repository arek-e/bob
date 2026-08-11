import { eq } from "drizzle-orm"

import type { CoreDatabase } from "../../database.ts"

import { effectAttempts } from "../conversations/schema.ts"

export interface EffectIdentity {
  readonly ownerId: string
  readonly kind: string
  readonly idempotencyKey: string
}

export async function completedEffect(
  database: CoreDatabase,
  identity: EffectIdentity
): Promise<string | undefined> {
  const [existing] = await database
    .select()
    .from(effectAttempts)
    .where(eq(effectAttempts.idempotencyKey, identity.idempotencyKey))
    .limit(1)
  if (existing === undefined) return undefined
  if (existing.userId !== identity.ownerId || existing.kind !== identity.kind) {
    throw new Error("The idempotency key belongs to a different operation")
  }
  if (existing.state !== "completed" || existing.resultRef === null) {
    throw new Error("The previous operation outcome is unknown")
  }
  return existing.resultRef
}

export function completeEffect(
  database: CoreDatabase,
  identity: EffectIdentity,
  resultRef: string,
  id: string,
  at: string
) {
  return database.insert(effectAttempts).values({
    id,
    userId: identity.ownerId,
    kind: identity.kind,
    idempotencyKey: identity.idempotencyKey,
    state: "completed",
    resultRef,
    createdAt: at,
    updatedAt: at
  })
}

export async function completedEffectAfterConflict(
  database: CoreDatabase,
  identity: EffectIdentity,
  error: unknown
): Promise<string> {
  const completed = await completedEffect(database, identity)
  if (completed !== undefined) return completed
  throw error
}
