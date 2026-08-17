import type { CoreDatabase } from "@bob/db-types"
import type { DataProtection } from "@bob/policy-types/data-protection"

import {
  MessageAttachmentError,
  MessageAttachmentStore,
  type ImageMediaType,
  type MessageAttachmentReference
} from "@bob/conversations-types/attachment-store"
import {
  agentRuns,
  conversationTurnMessages,
  inboundEvents,
  messageAttachments
} from "@bob/db-service/schema/conversations"
import { ObjectStorage } from "@bob/object-store-types"
import { OwnerDataKeyStore } from "@bob/policy-types/owner-data-key"
import { and, eq, lte } from "drizzle-orm"
import { Effect, Layer } from "effect"

const maximumImageBytes = 5 * 1024 * 1024

function validImage(mediaType: ImageMediaType, body: Uint8Array): boolean {
  if (mediaType === "image/png") {
    return (
      body.length >= 8 &&
      body[0] === 0x89 &&
      body[1] === 0x50 &&
      body[2] === 0x4e &&
      body[3] === 0x47 &&
      body[4] === 0x0d &&
      body[5] === 0x0a &&
      body[6] === 0x1a &&
      body[7] === 0x0a
    )
  }
  return body.length >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff
}

function reference(row: typeof messageAttachments.$inferSelect): MessageAttachmentReference {
  return {
    id: row.id,
    mediaType: row.mediaType,
    byteLength: row.byteLength,
    contentHash: row.contentHash
  }
}

const failure = (code: MessageAttachmentError["code"], cause?: unknown) =>
  cause === undefined
    ? new MessageAttachmentError({ code })
    : new MessageAttachmentError({ code, cause })

export function messageAttachmentStoreLayer(
  database: CoreDatabase,
  protection: DataProtection,
  options: { readonly now?: () => Date; readonly randomUuid?: () => string } = {}
) {
  const now = options.now ?? (() => new Date())
  const randomUuid = options.randomUuid ?? (() => crypto.randomUUID())

  return Layer.effect(
    MessageAttachmentStore,
    Effect.gen(function* () {
      const storage = yield* ObjectStorage
      const ownerDataKeys = yield* OwnerDataKeyStore

      return MessageAttachmentStore.of({
        storeInbound: (eventId, ordinal, mediaType, body) =>
          Effect.gen(function* () {
            if (body.byteLength > maximumImageBytes) return yield* failure("too_large")
            if (!validImage(mediaType, body)) return yield* failure("invalid_media")
            if (!Number.isSafeInteger(ordinal) || ordinal < 0) {
              return yield* failure("invalid_media")
            }

            const [existing] = yield* database
              .select()
              .from(messageAttachments)
              .where(
                and(
                  eq(messageAttachments.inboundEventId, eventId),
                  eq(messageAttachments.ordinal, ordinal)
                )
              )
              .limit(1)
            if (existing !== undefined) return reference(existing)

            const [event] = yield* database
              .select({
                ownerId: inboundEvents.userId,
                messageId: inboundEvents.messageId,
                attachmentCount: inboundEvents.attachmentCount
              })
              .from(inboundEvents)
              .where(eq(inboundEvents.id, eventId))
              .limit(1)
            if (event === undefined || ordinal >= event.attachmentCount) {
              return yield* failure("event_missing")
            }

            const owner = yield* ownerDataKeys.load(event.ownerId)
            const [encrypted, contentHash] = yield* Effect.tryPromise({
              try: () =>
                Promise.all([
                  protection.encryptBytes(owner.key, body),
                  protection.contentHashBytes(body)
                ]),
              catch: (cause) => failure("storage_failed", cause)
            })
            const id = randomUuid()
            const objectKey = `owners/${event.ownerId}/attachments/${id}`
            yield* storage.put(objectKey, encrypted.ciphertext)

            const insert = database
              .insert(messageAttachments)
              .values({
                id,
                userId: event.ownerId,
                messageId: event.messageId,
                inboundEventId: eventId,
                ordinal,
                objectKey,
                mediaType,
                byteLength: body.byteLength,
                contentHash,
                objectIv: encrypted.iv,
                dataKeyVersion: owner.version,
                createdAt: now().toISOString()
              })
              .onConflictDoNothing()
              .returning()
            const inserted = yield* insert.pipe(
              Effect.catch((cause) =>
                storage.delete(objectKey).pipe(
                  Effect.catch(() => Effect.void),
                  Effect.flatMap(() => Effect.fail(failure("storage_failed", cause)))
                )
              )
            )
            if (inserted[0] !== undefined) return reference(inserted[0])

            yield* storage.delete(objectKey).pipe(Effect.catch(() => Effect.void))
            const [winner] = yield* database
              .select()
              .from(messageAttachments)
              .where(
                and(
                  eq(messageAttachments.inboundEventId, eventId),
                  eq(messageAttachments.ordinal, ordinal)
                )
              )
              .limit(1)
            if (winner === undefined) return yield* failure("storage_failed")
            return reference(winner)
          }).pipe(
            Effect.mapError((cause) =>
              cause instanceof MessageAttachmentError ? cause : failure("storage_failed", cause)
            )
          ),

        loadForAgent: (runId, attachmentId) =>
          Effect.gen(function* () {
            const [run] = yield* database
              .select({
                ownerId: agentRuns.userId,
                turnId: agentRuns.conversationTurnId,
                turnRevision: agentRuns.conversationTurnRevision
              })
              .from(agentRuns)
              .where(eq(agentRuns.id, runId))
              .limit(1)
            if (run?.turnId == null || run.turnRevision == null) {
              return yield* failure("attachment_missing")
            }

            const [attachment] = yield* database
              .select()
              .from(messageAttachments)
              .where(
                and(
                  eq(messageAttachments.id, attachmentId),
                  eq(messageAttachments.userId, run.ownerId)
                )
              )
              .limit(1)
            if (attachment === undefined) return yield* failure("attachment_missing")

            const [linked] = yield* database
              .select({ messageId: conversationTurnMessages.messageId })
              .from(conversationTurnMessages)
              .where(
                and(
                  eq(conversationTurnMessages.turnId, run.turnId),
                  eq(conversationTurnMessages.messageId, attachment.messageId),
                  lte(conversationTurnMessages.revision, run.turnRevision)
                )
              )
              .limit(1)
            if (linked === undefined) return yield* failure("attachment_missing")

            const stored = yield* storage.get(attachment.objectKey)
            if (stored === undefined) return yield* failure("object_missing")
            const owner = yield* ownerDataKeys.load(run.ownerId)
            const body = yield* Effect.tryPromise({
              try: () =>
                protection.decryptBytes(owner.key, {
                  ciphertext: stored.body,
                  iv: attachment.objectIv
                }),
              catch: (cause) => failure("storage_failed", cause)
            })
            const contentHash = yield* Effect.tryPromise({
              try: () => protection.contentHashBytes(body),
              catch: (cause) => failure("storage_failed", cause)
            })
            if (
              body.byteLength !== attachment.byteLength ||
              contentHash !== attachment.contentHash ||
              !validImage(attachment.mediaType, body)
            ) {
              return yield* failure("object_missing")
            }
            return { ...reference(attachment), body }
          }).pipe(
            Effect.mapError((cause) =>
              cause instanceof MessageAttachmentError ? cause : failure("storage_failed", cause)
            )
          )
      })
    })
  )
}
