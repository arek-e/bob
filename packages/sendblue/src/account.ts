import { Schema } from "effect"

import { timingSafeEqual } from "./webhooks.ts"

const WebhookValue = Schema.Union([
  Schema.String,
  Schema.Struct({ url: Schema.String, secret: Schema.optionalKey(Schema.String) })
])
const WebhookList = Schema.Struct({
  status: Schema.optionalKey(Schema.String),
  webhooks: Schema.Struct({
    receive: Schema.optionalKey(Schema.Array(WebhookValue)),
    outbound: Schema.optionalKey(Schema.Array(WebhookValue)),
    call_log: Schema.optionalKey(Schema.Array(WebhookValue)),
    contact_created: Schema.optionalKey(Schema.Array(WebhookValue)),
    line_assigned: Schema.optionalKey(Schema.Array(WebhookValue)),
    line_blocked: Schema.optionalKey(Schema.Array(WebhookValue)),
    typing_indicator: Schema.optionalKey(Schema.Array(WebhookValue)),
    globalSecret: Schema.optionalKey(Schema.String)
  })
})

export interface AccountClientOptions {
  readonly apiKeyId: string
  readonly apiSecretKey: string
  readonly baseUrl?: string
  readonly fetch?: typeof fetch
}

export interface RequiredWebhooks {
  readonly receiveUrl: string
  readonly outboundUrl: string
  readonly globalSecret: string
}

export interface ReconcilePlan {
  readonly secretMatches: boolean
  readonly receiveCount: number
  readonly outboundCount: number
  readonly additions: readonly { type: "receive" | "outbound"; url: string }[]
  readonly valid: boolean
}

function urlOf(value: typeof WebhookValue.Type): string {
  return Schema.is(Schema.String)(value) ? value : value.url
}

export async function planWebhookReconciliation<Input>(
  currentInput: Input,
  required: RequiredWebhooks
): Promise<ReconcilePlan> {
  const current = Schema.decodeUnknownSync(WebhookList)(currentInput)
  const secretMatches = await timingSafeEqual(
    current.webhooks.globalSecret ?? "",
    required.globalSecret
  )
  const receiveCount = (current.webhooks.receive ?? []).filter(
    (item) => urlOf(item) === required.receiveUrl
  ).length
  const outboundCount = (current.webhooks.outbound ?? []).filter(
    (item) => urlOf(item) === required.outboundUrl
  ).length
  const additions: { type: "receive" | "outbound"; url: string }[] = []
  if (secretMatches && receiveCount === 0)
    additions.push({ type: "receive", url: required.receiveUrl })
  if (secretMatches && outboundCount === 0)
    additions.push({ type: "outbound", url: required.outboundUrl })
  return {
    secretMatches,
    receiveCount,
    outboundCount,
    additions,
    valid: secretMatches && receiveCount <= 1 && outboundCount <= 1
  }
}

export function createAccountClient(options: AccountClientOptions) {
  const request = options.fetch ?? fetch
  const url = `${options.baseUrl ?? "https://api.sendblue.com"}/api/account/webhooks`
  const headers = {
    "sb-api-key-id": options.apiKeyId,
    "sb-api-secret-key": options.apiSecretKey
  }

  async function list(): Promise<typeof WebhookList.Type> {
    const response = await request(url, { headers })
    if (!response.ok) throw new Error(`Sendblue webhook list failed: ${response.status}`)
    return Schema.decodeUnknownSync(WebhookList)(await response.json())
  }

  return {
    list,
    async reconcile(required: RequiredWebhooks, checkOnly: boolean): Promise<ReconcilePlan> {
      let plan = await planWebhookReconciliation(await list(), required)
      if (!plan.secretMatches || !plan.valid || checkOnly) return plan

      for (const addition of plan.additions) {
        const response = await request(url, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ webhooks: [addition.url], type: addition.type })
        })
        if (!response.ok) throw new Error(`Sendblue webhook add failed: ${response.status}`)
      }

      plan = await planWebhookReconciliation(await list(), required)
      if (!plan.valid || plan.additions.length > 0) {
        throw new Error("Sendblue webhook verification failed")
      }
      return plan
    }
  }
}
