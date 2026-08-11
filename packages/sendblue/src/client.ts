import type { DeliveryReconciliationResult, OutboxClaim } from "@bob/contracts/delivery"

import { Schema } from "effect"

const SendResponse = Schema.Struct({
  message_handle: Schema.String,
  status: Schema.optionalKey(Schema.String)
})

const StatusResponse = Schema.Struct({
  message_handle: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  status: Schema.Literals([
    "REGISTERED",
    "PENDING",
    "DECLINED",
    "QUEUED",
    "ACCEPTED",
    "SENT",
    "DELIVERED",
    "ERROR",
    "SUCCESS"
  ]),
  date_updated: Schema.optionalKey(Schema.String),
  date_sent: Schema.optionalKey(Schema.String)
})

const normalizedStatus = {
  REGISTERED: "registered",
  PENDING: "pending",
  DECLINED: "declined",
  QUEUED: "queued",
  ACCEPTED: "accepted",
  SENT: "sent",
  DELIVERED: "delivered",
  ERROR: "error",
  SUCCESS: "accepted"
} as const

export interface SendblueCredentials {
  readonly apiKeyId: string
  readonly apiSecretKey: string
}

export type SendOutcome =
  | { readonly state: "accepted"; readonly providerMessageHandle: string }
  | { readonly state: "failed"; readonly code: string }
  | { readonly state: "uncertain"; readonly code: string }

export interface SendblueClientOptions extends SendblueCredentials {
  readonly baseUrl?: string
  readonly timeoutMs?: number
  readonly fetch?: typeof fetch
}

export function createSendblueClient(options: SendblueClientOptions) {
  const request = options.fetch ?? fetch
  const baseUrl = options.baseUrl ?? "https://api.sendblue.com"
  const timeoutMs = options.timeoutMs ?? 15_000

  return {
    async sendMessage(claim: OutboxClaim, statusCallback?: string): Promise<SendOutcome> {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort("sendblue_timeout"), timeoutMs)
      try {
        const response = await request(`${baseUrl}/api/send-message`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "sb-api-key-id": options.apiKeyId,
            "sb-api-secret-key": options.apiSecretKey
          },
          body: JSON.stringify({
            number: claim.number,
            from_number: claim.fromNumber,
            content: claim.smsSafeText,
            ...(statusCallback === undefined ? {} : { status_callback: statusCallback })
          }),
          signal: controller.signal
        })

        if (!response.ok) {
          return { state: "failed", code: `http_${response.status}` }
        }

        try {
          const body = Schema.decodeUnknownSync(SendResponse)(await response.json())
          return { state: "accepted", providerMessageHandle: body.message_handle }
        } catch {
          return { state: "uncertain", code: "invalid_success_response" }
        }
      } catch (error) {
        return {
          state: "uncertain",
          code: error instanceof DOMException && error.name === "AbortError" ? "timeout" : "network"
        }
      } finally {
        clearTimeout(timeout)
      }
    },

    async getStatus(handle: string): Promise<DeliveryReconciliationResult> {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort("sendblue_timeout"), timeoutMs)
      try {
        const response = await request(
          `${baseUrl}/api/status?handle=${encodeURIComponent(handle)}`,
          {
            headers: {
              "sb-api-key-id": options.apiKeyId,
              "sb-api-secret-key": options.apiSecretKey
            },
            signal: controller.signal
          }
        )
        if (!response.ok) throw new Error(`Sendblue status request failed: ${response.status}`)
        const body = Schema.decodeUnknownSync(StatusResponse)(await response.json())
        if (body.message_handle !== handle) {
          throw new Error("Sendblue returned a different message handle")
        }
        const occurredAt = body.date_updated ?? body.date_sent
        if (occurredAt === undefined || !Number.isFinite(Date.parse(occurredAt))) {
          throw new Error("Sendblue returned an invalid status date")
        }
        return {
          messageHandle: body.message_handle,
          status: normalizedStatus[body.status],
          occurredAt: new Date(occurredAt).toISOString()
        }
      } finally {
        clearTimeout(timeout)
      }
    }
  }
}
