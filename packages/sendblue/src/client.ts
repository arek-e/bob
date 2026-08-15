import type { OutboxClaim } from "@bob/contracts/delivery"

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
    "OPTED_OUT"
  ])
})

export type SendblueStatus = typeof StatusResponse.Type

export interface SendblueCredentials {
  readonly apiKeyId: string
  readonly apiSecretKey: string
}

export type SendOutcome =
  | { readonly state: "accepted"; readonly providerMessageHandle: string }
  | { readonly state: "failed"; readonly code: string }
  | { readonly state: "uncertain"; readonly code: string }

export type InteractionOutcome =
  | { readonly state: "accepted" }
  | { readonly state: "failed"; readonly code: string }
  | { readonly state: "uncertain"; readonly code: string }

export interface SendblueClientOptions extends SendblueCredentials {
  readonly baseUrl?: string
  readonly timeoutMs?: number
  readonly interactionTimeoutMs?: number
  readonly fetch?: typeof fetch
}

export function createSendblueClient(options: SendblueClientOptions) {
  const request = options.fetch ?? fetch
  const baseUrl = options.baseUrl ?? "https://api.sendblue.com"
  const timeoutMs = options.timeoutMs ?? 15_000
  const interactionTimeoutMs = options.interactionTimeoutMs ?? 2_500
  const headers = {
    "content-type": "application/json",
    "sb-api-key-id": options.apiKeyId,
    "sb-api-secret-key": options.apiSecretKey
  }

  async function sendInteraction<Body>(path: string, body: Body): Promise<InteractionOutcome> {
    const controller = new AbortController()
    const timeout = setTimeout(
      () => controller.abort("sendblue_interaction_timeout"),
      interactionTimeoutMs
    )
    try {
      const response = await request(`${baseUrl}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal
      })
      if (response.ok) return { state: "accepted" }
      if (response.status === 408 || response.status === 429 || response.status >= 500) {
        return { state: "uncertain", code: `http_${response.status}` }
      }
      return { state: "failed", code: `http_${response.status}` }
    } catch (error) {
      return {
        state: "uncertain",
        code: error instanceof DOMException && error.name === "AbortError" ? "timeout" : "network"
      }
    } finally {
      clearTimeout(timeout)
    }
  }

  return {
    async sendMessage(claim: OutboxClaim, statusCallback?: string): Promise<SendOutcome> {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort("sendblue_timeout"), timeoutMs)
      try {
        const messageBody = {
          number: claim.number,
          from_number: claim.fromNumber,
          content: claim.smsSafeText
        }
        if (claim.replyToMessageHandle !== undefined)
          Object.assign(messageBody, { reply_to: { message_handle: claim.replyToMessageHandle } })
        if (statusCallback !== undefined)
          Object.assign(messageBody, { status_callback: statusCallback })
        const send = <Body>(body: Body) =>
          request(`${baseUrl}/api/send-message`, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            signal: controller.signal
          })
        let response = await send(messageBody)
        const canSafelyFallback =
          claim.replyToMessageHandle !== undefined &&
          response.status >= 400 &&
          response.status < 500 &&
          response.status !== 408 &&
          response.status !== 429
        if (canSafelyFallback) {
          const fallbackBody = {
            number: claim.number,
            from_number: claim.fromNumber,
            content: claim.smsSafeText
          }
          if (statusCallback !== undefined)
            Object.assign(fallbackBody, { status_callback: statusCallback })
          response = await send(fallbackBody)
        }

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

    sendReaction(input: {
      readonly fromNumber: string
      readonly messageHandle: string
      readonly reaction: "love" | "like" | "dislike" | "laugh" | "emphasize" | "question"
    }): Promise<InteractionOutcome> {
      return sendInteraction("/api/send-reaction", {
        from_number: input.fromNumber,
        message_handle: input.messageHandle,
        reaction: input.reaction
      })
    },

    sendTypingIndicator(input: {
      readonly number: string
      readonly fromNumber: string
      readonly state: "start" | "stop"
      readonly maxDurationMs?: number
    }): Promise<InteractionOutcome> {
      const body = {
        number: input.number,
        from_number: input.fromNumber,
        state: input.state
      }
      if (input.maxDurationMs !== undefined)
        Object.assign(body, { max_duration_ms: input.maxDurationMs })
      return sendInteraction("/api/send-typing-indicator", body)
    },

    async getStatus(handle: string): Promise<SendblueStatus> {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort("sendblue_status_timeout"), timeoutMs)
      try {
        const response = await request(
          `${baseUrl}/api/status?handle=${encodeURIComponent(handle)}`,
          { headers, signal: controller.signal }
        )
        if (!response.ok) throw new Error(`Sendblue status request failed: ${response.status}`)
        return Schema.decodeUnknownSync(StatusResponse)(await response.json())
      } finally {
        clearTimeout(timeout)
      }
    }
  }
}
