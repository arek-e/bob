import type { SendblueWebhookPayload } from "@bob/sendblue-types/webhooks"

const HISTORY_LOOKBACK_MS = 15 * 60 * 1_000
const HISTORY_FUTURE_SKEW_MS = 60 * 1_000

interface HistoryClient {
  readonly hasLine: (sendblueNumber: string) => Promise<boolean>
  readonly listInbound: (window: {
    readonly sendblueNumber: string
    readonly since: Date
    readonly until: Date
  }) => Promise<readonly SendblueWebhookPayload[]>
}

interface ReplayRequest {
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
}

interface ReconcileInboundHistoryOptions {
  readonly history: HistoryClient
  readonly sendblueNumber: string
  readonly ownerNumber: string
  readonly signingSecret: string
  readonly scheduledAt: Date
  readonly accept: (request: ReplayRequest) => Promise<Response>
}

export async function reconcileInboundHistory(options: ReconcileInboundHistoryOptions) {
  if (!(await options.history.hasLine(options.sendblueNumber))) {
    throw new Error("sendblue_line_unavailable")
  }

  const messages = await options.history.listInbound({
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
    const result = await options.accept({
      headers: {
        "content-type": "application/json",
        "sb-signing-secret": options.signingSecret
      },
      body: JSON.stringify(message)
    })
    if (!result.ok) throw new Error(`sendblue_history_replay_http_${result.status}`)
  }

  return {
    retrieved: messages.length,
    replayed: ownerMessages.length,
    skipped: messages.length - ownerMessages.length
  }
}
