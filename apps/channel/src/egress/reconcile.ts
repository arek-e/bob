import { Effect } from "effect"

import { SendblueProvider } from "../sendblue/provider.ts"

const HISTORY_LOOKBACK_MS = 15 * 60 * 1_000
const HISTORY_FUTURE_SKEW_MS = 60 * 1_000

interface ReconcileInboundHistoryOptions {
  readonly sendblueNumber: string
  readonly ownerNumber: string
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
      return yield* Effect.fail(new Error("sendblue_line_unavailable"))
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
          message.from_number === options.ownerNumber &&
          message.to_number === options.sendblueNumber
      )
      .toSorted((left, right) => left.date_sent.localeCompare(right.date_sent))

    for (const message of ownerMessages) {
      const result = yield* Effect.tryPromise({
        try: (signal) =>
          options.accept({
            headers: {
              "content-type": "application/json",
              "sb-signing-secret": options.signingSecret
            },
            body: JSON.stringify(message),
            signal
          }),
        catch: (cause) => cause
      }).pipe(Effect.timeout(10_000))
      if (!result.ok) {
        return yield* Effect.fail(new Error(`sendblue_history_replay_http_${result.status}`))
      }
    }
    return {
      retrieved: messages.length,
      replayed: ownerMessages.length,
      skipped: messages.length - ownerMessages.length
    }
  })
}
