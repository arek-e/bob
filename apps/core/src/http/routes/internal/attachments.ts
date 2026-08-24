import type { MessageAttachmentError } from "@bob/conversations-types/attachment-store"

export function attachmentFailureStatus(error: MessageAttachmentError): number {
  if (error.code === "too_large") return 413
  if (error.code === "invalid_media") return 415
  if (
    error.code === "event_missing" ||
    error.code === "attachment_missing" ||
    error.code === "object_missing"
  ) {
    return 404
  }
  return 503
}
