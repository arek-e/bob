import { Schema } from "effect"

import { SendblueWebhookPayload } from "./webhooks.ts"

const MessageList = Schema.Struct({
  status: Schema.String,
  data: Schema.Array(SendblueWebhookPayload),
  pagination: Schema.optionalKey(
    Schema.Struct({
      total: Schema.optionalKey(Schema.Number)
    })
  )
})

const LineList = Schema.Struct({ numbers: Schema.Array(Schema.String) })

export interface SendblueHistoryClientOptions {
  readonly apiKeyId: string
  readonly apiSecretKey: string
  readonly baseUrl?: string
  readonly fetch?: typeof fetch
}

export interface InboundHistoryWindow {
  readonly sendblueNumber: string
  readonly since: Date
  readonly until: Date
}

export function createSendblueHistoryClient(options: SendblueHistoryClientOptions) {
  const request = options.fetch ?? fetch
  const baseUrl = options.baseUrl ?? "https://api.sendblue.com"
  const headers = {
    "sb-api-key-id": options.apiKeyId,
    "sb-api-secret-key": options.apiSecretKey
  }

  return {
    async listInbound(window: InboundHistoryWindow) {
      const url = new URL("/api/v2/messages", baseUrl)
      url.searchParams.set("is_outbound", "false")
      url.searchParams.set("limit", "1000")
      url.searchParams.set("sendblue_number", window.sendblueNumber)
      url.searchParams.set("sent_at_gte", window.since.toISOString())
      url.searchParams.set("sent_at_lte", window.until.toISOString())
      const response = await request(url, { headers })
      if (!response.ok) throw new Error(`sendblue_history_http_${response.status}`)
      return Schema.decodeUnknownSync(MessageList)(await response.json()).data
    },

    async hasLine(sendblueNumber: string): Promise<boolean> {
      const response = await request(new URL("/api/lines", baseUrl), { headers })
      if (!response.ok) throw new Error(`sendblue_lines_http_${response.status}`)
      const lines = Schema.decodeUnknownSync(LineList)(await response.json())
      return lines.numbers.includes(sendblueNumber)
    }
  }
}
