import { Effect } from "effect"

import { SendblueEgress } from "./composition.ts"
import { reconcileInboundHistory } from "./reconcile.ts"

function recoveryErrorCode(cause: unknown): string {
  if (
    cause instanceof Error &&
    /^sendblue_(?:history_http_[1-5]\d{2}|history_replay_http_[1-5]\d{2}|lines_http_[1-5]\d{2}|line_unavailable)$/u.test(
      cause.message
    )
  ) {
    return cause.message
  }
  if (typeof cause === "object" && cause !== null && "_tag" in cause) return String(cause._tag)
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
        const request = {
          method: "POST",
          headers,
          body,
          ...(signal === undefined ? {} : { signal })
        }
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
