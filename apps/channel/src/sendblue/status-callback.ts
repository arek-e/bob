import type {
  ReadSendblueStatusCallbackContext,
  SendblueStatusCallbackContext
} from "./status-callback-schema.ts"

const MAX_STATUS_CALLBACK_LENGTH = 255

function callbackParameter(parameters: URLSearchParams, compact: string, existing: string) {
  return parameters.get(compact) ?? parameters.get(existing)
}

export function buildSendblueStatusCallback(
  baseUrl: string,
  context: SendblueStatusCallbackContext
): string {
  const callback = new URL(baseUrl)
  callback.searchParams.set("o", context.outboxId)
  callback.searchParams.set("a", context.attemptId)
  callback.searchParams.set("c", context.correlationId)
  if (context.traceparent !== null) callback.searchParams.set("t", context.traceparent)
  if (callback.toString().length > MAX_STATUS_CALLBACK_LENGTH) callback.searchParams.delete("c")
  if (callback.toString().length > MAX_STATUS_CALLBACK_LENGTH) callback.searchParams.delete("t")
  const value = callback.toString()
  if (value.length > MAX_STATUS_CALLBACK_LENGTH) {
    throw new Error("sendblue_status_callback_too_long")
  }
  return value
}

export function readSendblueStatusCallback(url: URL): ReadSendblueStatusCallbackContext {
  const outboxId = callbackParameter(url.searchParams, "o", "outbox_id")
  const attemptId = callbackParameter(url.searchParams, "a", "attempt_id")
  const correlationId = callbackParameter(url.searchParams, "c", "correlation_id")
  const traceparent = callbackParameter(url.searchParams, "t", "traceparent")
  const context: ReadSendblueStatusCallbackContext = {}
  if (outboxId !== null) Object.assign(context, { outboxId })
  if (attemptId !== null) Object.assign(context, { attemptId })
  if (correlationId !== null) Object.assign(context, { correlationId })
  if (traceparent !== null) Object.assign(context, { traceparent })
  return context
}
