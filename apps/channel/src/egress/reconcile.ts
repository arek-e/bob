import { Data, Effect } from "effect"

import { SendblueProvider } from "../sendblue/provider.ts"

const HISTORY_LOOKBACK_MS = 15 * 60 * 1_000
const HISTORY_FUTURE_SKEW_MS = 60 * 1_000

export class InboundReconciliationError extends Data.TaggedError("InboundReconciliationError")<{
  readonly code: "sendblue_line_unavailable" | "sendblue_history_replay_failed"
  readonly status?: number
  readonly cause?: unknown
}> {
  override get message(): string {
    return this.status === undefined ? this.code : `sendblue_history_replay_http_${this.status}`
  }
}

interface ReconcileInboundHistoryOptions {
  readonly sendblueNumber: string
  readonly signingSecret: string
  readonly scheduledAt: Date
  readonly accept: (request: {
    readonly headers: Readonly<Record<string, string>>
    readonly body: string
    readonly signal?: AbortSignal
  }) => Promise<Response>
}

export function reconcileInboundHistory(options: ReconcileInboundHistoryOptions) {
  return Effect.gen(function* () {
    const sendblue = yield* SendblueProvider
    if (!(yield* sendblue.hasLine(options.sendblueNumber))) {
      return yield* new InboundReconciliationError({ code: "sendblue_line_unavailable" })
    }
    const messages = yield* sendblue.listInbound({
      sendblueNumber: options.sendblueNumber,
      since: new Date(options.scheduledAt.getTime() - HISTORY_LOOKBACK_MS),
      until: new Date(options.scheduledAt.getTime() + HISTORY_FUTURE_SKEW_MS)
    })
    const ownerMessages = messages
      .filter(
        (message) =>
          !message.is_outbound &&
          message.status === "RECEIVED" &&
          message.to_number === options.sendblueNumber
      )
      .toSorted((left, right) => left.date_sent.localeCompare(right.date_sent))

    for (const message of ownerMessages) {
      const result = yield* Effect.tryPromise({
        try: (signal) =>
          options.accept({
            headers: {
              "content-type": "application/json",
              "sb-signing-secret": options.signingSecret,
              "x-bob-ingress-source": "recovery_replay"
            },
            body: JSON.stringify(message),
            signal
          }),
        catch: (cause) =>
          new InboundReconciliationError({
            code: "sendblue_history_replay_failed",
            cause
          })
      }).pipe(Effect.timeout(10_000))
      if (!result.ok) {
        return yield* new InboundReconciliationError({
          code: "sendblue_history_replay_failed",
          status: result.status
        })
      }
    }
    return {
      retrieved: messages.length,
      replayed: ownerMessages.length,
      skipped: messages.length - ownerMessages.length
    }
  })
}
