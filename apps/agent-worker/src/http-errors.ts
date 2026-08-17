import { Data } from "effect"

export class RequestBodyTooLargeError extends Data.TaggedError("RequestBodyTooLargeError") {
  override get message(): string {
    return "body_too_large"
  }
}
