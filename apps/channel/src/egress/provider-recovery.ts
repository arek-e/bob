import { Effect, Schema } from "effect"

import { SendblueEgress } from "./composition.ts"
import { InboundReconciliationError, reconcileInboundHistory } from "./reconcile.ts"

function recoveryErrorCode(cause: unknown): string {
  if (cause instanceof InboundReconciliationError) {
    return cause.status === undefined ? cause.code : `sendblue_history_replay_http_${cause.status}`
  }
  if (
    cause instanceof Error &&
    /^sendblue_(?:history_http_[1-5]\d{2}|history_replay_http_[1-5]\d{2}|lines_http_[1-5]\d{2}|line_unavailable)$/u.test(
      cause.message
    )
  ) {
    return cause.message
  }
  const tagged = Schema.decodeUnknownExit(Schema.Struct({ _tag: Schema.String }))(cause)
  if (tagged._tag === "Success") return tagged.value._tag
  return "unknown"
}

export function handleScheduledReconcile(scheduledAt: Date) {
  return Effect.gen(function* () {
    const egress = yield* SendblueEgress
    const result = yield* reconcileInboundHistory({
      sendblueNumber: egress.config.SENDBLUE_FROM_NUMBER,
      ownerNumber: egress.config.SENDBLUE_ALLOWED_USER_NUMBER,
      signingSecret: egress.config.SENDBLUE_WEBHOOK_SIGNING_SECRET,
      scheduledAt,
      accept: ({ headers, body, signal }) => {
        const request: RequestInit = {
          method: "POST",
          headers,
          body
        }
        if (signal !== undefined) request.signal = signal
        return egress.ingress.fetch("https://ingress.internal/webhooks/receive", request)
      }
    })
    yield* Effect.sync(() =>
      console.log(JSON.stringify({ type: "inbound_reconcile", status: "completed", ...result }))
    )
    return result
  }).pipe(
    Effect.tapError((error) =>
      Effect.sync(() =>
        console.error(
          JSON.stringify({
            type: "inbound_reconcile",
            status: "failed",
            code: recoveryErrorCode(error)
          })
        )
      )
    )
  )
}
