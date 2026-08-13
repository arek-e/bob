import { createSendblueHistoryClient } from "@bob/sendblue/history"
import { Schema } from "effect"

import type { EgressBindings } from "../bindings.ts"

import { reconcileInboundHistory } from "./reconcile.ts"

const RecoveryConfiguration = Schema.Struct({
  SENDBLUE_API_KEY_ID: Schema.String.check(Schema.isMinLength(1)),
  SENDBLUE_API_SECRET_KEY: Schema.String.check(Schema.isMinLength(1)),
  SENDBLUE_WEBHOOK_SIGNING_SECRET: Schema.String.check(Schema.isMinLength(32)),
  SENDBLUE_FROM_NUMBER: Schema.String.check(Schema.isPattern(/^\+[1-9]\d{7,14}$/)),
  SENDBLUE_ALLOWED_USER_NUMBER: Schema.String.check(Schema.isPattern(/^\+[1-9]\d{7,14}$/))
})

function recoveryErrorCode(error: unknown): string {
  if (
    error instanceof Error &&
    /^sendblue_(?:history_http_[1-5]\d{2}|history_replay_http_[1-5]\d{2}|lines_http_[1-5]\d{2}|line_unavailable)$/u.test(
      error.message
    )
  ) {
    return error.message
  }
  return "unknown"
}

export async function handleScheduledReconcile(scheduledAt: Date, bindings: EgressBindings) {
  try {
    const config = Schema.decodeUnknownSync(RecoveryConfiguration)(bindings)
    const history = createSendblueHistoryClient({
      apiKeyId: config.SENDBLUE_API_KEY_ID,
      apiSecretKey: config.SENDBLUE_API_SECRET_KEY
    })
    const result = await reconcileInboundHistory({
      history,
      sendblueNumber: config.SENDBLUE_FROM_NUMBER,
      ownerNumber: config.SENDBLUE_ALLOWED_USER_NUMBER,
      signingSecret: config.SENDBLUE_WEBHOOK_SIGNING_SECRET,
      scheduledAt,
      accept: ({ headers, body }) =>
        bindings.INGRESS.fetch("https://ingress.internal/webhooks/receive", {
          method: "POST",
          headers,
          body,
          signal: AbortSignal.timeout(10_000)
        })
    })
    console.log(JSON.stringify({ type: "inbound_reconcile", status: "completed", ...result }))
    return result
  } catch (error) {
    console.error(
      JSON.stringify({
        type: "inbound_reconcile",
        status: "failed",
        code: recoveryErrorCode(error)
      })
    )
    throw error
  }
}
