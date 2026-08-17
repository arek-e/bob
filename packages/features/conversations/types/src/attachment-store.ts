import { Uuid } from "@bob/capabilities-types/shared"
import { Context, type Effect, Schema } from "effect"

export const ImageMediaType = Schema.Literals(["image/jpeg", "image/png"])
export type ImageMediaType = typeof ImageMediaType.Type

export const MessageAttachmentReference = Schema.Struct({
  id: Uuid,
  mediaType: ImageMediaType,
  byteLength: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 * 1024 * 1024 })),
  contentHash: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))
})
export type MessageAttachmentReference = typeof MessageAttachmentReference.Type

export interface LoadedMessageAttachment extends MessageAttachmentReference {
  readonly body: Uint8Array
}

export class MessageAttachmentError extends Schema.TaggedError<MessageAttachmentError>()(
  "MessageAttachmentError",
  {
    code: Schema.Literals([
      "invalid_media",
      "too_large",
      "event_missing",
      "attachment_missing",
      "object_missing",
      "storage_failed"
    ]),
    cause: Schema.optionalKey(Schema.Unknown)
  }
) {}

export interface MessageAttachmentStoreService {
  readonly storeInbound: (
    eventId: string,
    ordinal: number,
    mediaType: ImageMediaType,
    body: Uint8Array
  ) => Effect.Effect<MessageAttachmentReference, MessageAttachmentError>
  readonly loadForAgent: (
    runId: string,
    attachmentId: string
  ) => Effect.Effect<LoadedMessageAttachment, MessageAttachmentError>
}

export class MessageAttachmentStore extends Context.Service<
  MessageAttachmentStore,
  MessageAttachmentStoreService
>()("@bob/conversations/MessageAttachmentStore") {}
