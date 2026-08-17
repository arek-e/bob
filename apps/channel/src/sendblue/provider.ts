import type { OutboxClaim } from "@bob/delivery-types/delivery"

import { Context, Effect, flow, Layer, Redacted, Schema } from "effect"
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse
} from "effect/unstable/http"

import { SendblueWebhookPayload } from "./webhook-schema.ts"

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

const MessageList = Schema.Struct({
  status: Schema.String,
  data: Schema.Array(SendblueWebhookPayload),
  pagination: Schema.optionalKey(Schema.Struct({ total: Schema.optionalKey(Schema.Number) }))
})

const LineList = Schema.Struct({ numbers: Schema.Array(Schema.String) })

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

export const SendblueWebhookList = WebhookList

const MESSAGE_PAGE_LIMIT = "100"

export type SendblueStatus = typeof StatusResponse.Type

export type SendOutcome =
  | { readonly state: "accepted"; readonly providerMessageHandle: string }
  | { readonly state: "failed"; readonly code: string }
  | { readonly state: "uncertain"; readonly code: string }

export type InteractionOutcome =
  | { readonly state: "accepted" }
  | { readonly state: "failed"; readonly code: string }
  | { readonly state: "uncertain"; readonly code: string }

export interface InboundHistoryWindow {
  readonly sendblueNumber: string
  readonly since: Date
  readonly until: Date
}

export type OutboundHistoryWindow = InboundHistoryWindow

export interface RequiredWebhooks {
  readonly receiveUrl: string
  readonly outboundUrl: string
  readonly globalSecret: string
}

export interface ReconcilePlan {
  readonly state: "secret_mismatch" | "duplicate_hooks" | "changes_required" | "converged"
  readonly receiveCount: number
  readonly outboundCount: number
  readonly additions: readonly { type: "receive" | "outbound"; url: string }[]
}

export class SendblueTransportError extends Schema.TaggedError<SendblueTransportError>()(
  "SendblueTransportError",
  {
    operation: Schema.String,
    cause: Schema.Defect()
  }
) {}

export class SendblueTimeoutError extends Schema.TaggedError<SendblueTimeoutError>()(
  "SendblueTimeoutError",
  { operation: Schema.String }
) {}

export class SendblueHttpError extends Schema.TaggedError<SendblueHttpError>()(
  "SendblueHttpError",
  {
    operation: Schema.String,
    status: Schema.Int
  }
) {}

export class SendblueDecodeError extends Schema.TaggedError<SendblueDecodeError>()(
  "SendblueDecodeError",
  {
    operation: Schema.String,
    cause: Schema.Defect()
  }
) {}

export class SendblueVerificationError extends Schema.TaggedError<SendblueVerificationError>()(
  "SendblueVerificationError",
  { code: Schema.String }
) {}

export type SendblueProviderError =
  | SendblueTransportError
  | SendblueTimeoutError
  | SendblueHttpError
  | SendblueDecodeError
  | SendblueVerificationError

export interface SendblueProviderOptions {
  readonly apiKeyId: string
  readonly apiSecretKey: Redacted.Redacted<string>
  readonly baseUrl?: string
  readonly timeoutMs?: number
  readonly interactionTimeoutMs?: number
}

export class SendblueProvider extends Context.Service<
  SendblueProvider,
  {
    readonly sendMessage: (
      claim: OutboxClaim,
      statusCallback?: string
    ) => Effect.Effect<SendOutcome>
    readonly sendReaction: (input: {
      readonly fromNumber: string
      readonly messageHandle: string
      readonly reaction: "love" | "like" | "dislike" | "laugh" | "emphasize" | "question"
    }) => Effect.Effect<InteractionOutcome>
    readonly sendTypingIndicator: (input: {
      readonly number: string
      readonly fromNumber: string
      readonly state: "start" | "stop"
      readonly maxDurationMs?: number
    }) => Effect.Effect<InteractionOutcome>
    readonly getStatus: (handle: string) => Effect.Effect<SendblueStatus, SendblueProviderError>
    readonly listInbound: (
      window: InboundHistoryWindow
    ) => Effect.Effect<readonly SendblueWebhookPayload[], SendblueProviderError>
    readonly listOutbound: (
      window: OutboundHistoryWindow
    ) => Effect.Effect<readonly SendblueWebhookPayload[], SendblueProviderError>
    readonly hasLine: (sendblueNumber: string) => Effect.Effect<boolean, SendblueProviderError>
    readonly reconcileWebhooks: (
      required: RequiredWebhooks,
      checkOnly: boolean
    ) => Effect.Effect<ReconcilePlan, SendblueProviderError>
  }
>()("bob/sendblue/SendblueProvider") {}

function classifyHttpFailure(status: number) {
  const code = `http_${status}`
  return status === 408 || status === 429 || status >= 500
    ? ({ state: "uncertain", code } as const)
    : ({ state: "failed", code } as const)
}

function isSafeInlineReplyRejection(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429
}

function urlOf(value: typeof WebhookValue.Type): string {
  return Schema.is(Schema.String)(value) ? value : value.url
}

export function planWebhookReconciliation(
  current: typeof WebhookList.Type,
  required: RequiredWebhooks,
  secretMatches: boolean
): ReconcilePlan {
  const receiveCount = (current.webhooks.receive ?? []).filter(
    (item) => urlOf(item) === required.receiveUrl
  ).length
  const outboundCount = (current.webhooks.outbound ?? []).filter(
    (item) => urlOf(item) === required.outboundUrl
  ).length
  const additions: { type: "receive" | "outbound"; url: string }[] = []
  const hasDuplicateHooks = receiveCount > 1 || outboundCount > 1
  if (secretMatches && !hasDuplicateHooks && receiveCount === 0) {
    additions.push({ type: "receive", url: required.receiveUrl })
  }
  if (secretMatches && !hasDuplicateHooks && outboundCount === 0) {
    additions.push({ type: "outbound", url: required.outboundUrl })
  }
  return {
    state: !secretMatches
      ? "secret_mismatch"
      : hasDuplicateHooks
        ? "duplicate_hooks"
        : additions.length > 0
          ? "changes_required"
          : "converged",
    receiveCount,
    outboundCount,
    additions
  }
}

function providerLayer(options: SendblueProviderOptions) {
  return Layer.effect(
    SendblueProvider,
    Effect.gen(function* () {
      const baseUrl = options.baseUrl ?? "https://api.sendblue.com"
      const timeoutMs = options.timeoutMs ?? 15_000
      const interactionTimeoutMs = options.interactionTimeoutMs ?? 2_500
      const headers = {
        "sb-api-key-id": options.apiKeyId,
        "sb-api-secret-key": Redacted.value(options.apiSecretKey)
      }
      const client = (yield* HttpClient.HttpClient).pipe(
        HttpClient.mapRequest(
          flow(HttpClientRequest.prependUrl(baseUrl), HttpClientRequest.setHeaders(headers))
        )
      )

      const execute = (
        operation: string,
        request: HttpClientRequest.HttpClientRequest,
        timeout: number
      ) =>
        client.execute(request).pipe(
          Effect.timeout(timeout),
          Effect.mapError((cause): SendblueTransportError | SendblueTimeoutError =>
            cause._tag === "TimeoutError"
              ? new SendblueTimeoutError({ operation })
              : new SendblueTransportError({ operation, cause })
          )
        )

      const decode = <S extends Schema.Top>(
        operation: string,
        response: HttpClientResponse.HttpClientResponse,
        schema: S
      ) =>
        HttpClientResponse.schemaBodyJson(schema)(response).pipe(
          Effect.mapError((cause) => new SendblueDecodeError({ operation, cause }))
        )

      const requireOk = (operation: string, response: HttpClientResponse.HttpClientResponse) =>
        response.status >= 200 && response.status < 300
          ? Effect.succeed(response)
          : Effect.fail(new SendblueHttpError({ operation, status: response.status }))

      const sendInteraction = (path: string, body: typeof Schema.Json.Type) =>
        execute(
          "interaction",
          HttpClientRequest.post(path).pipe(
            HttpClientRequest.bodyText(JSON.stringify(body), "application/json")
          ),
          interactionTimeoutMs
        ).pipe(
          Effect.map((response): InteractionOutcome =>
            response.status >= 200 && response.status < 300
              ? { state: "accepted" }
              : classifyHttpFailure(response.status)
          ),
          Effect.catch((cause) =>
            Effect.succeed<InteractionOutcome>({
              state: "uncertain",
              code: cause._tag === "SendblueTimeoutError" ? "timeout" : "network"
            })
          )
        )

      const sendMessage = Effect.fn("SendblueProvider.sendMessage")(function* (
        claim: OutboxClaim,
        statusCallback?: string
      ) {
        const messageBody = {
          number: claim.number,
          from_number: claim.fromNumber,
          content: claim.smsSafeText
        }
        if (claim.replyToMessageHandle !== undefined) {
          Object.assign(messageBody, {
            reply_to: { message_handle: claim.replyToMessageHandle }
          })
        }
        if (statusCallback !== undefined)
          Object.assign(messageBody, { status_callback: statusCallback })
        const send = (body: typeof Schema.Json.Type) =>
          execute(
            "send_message",
            HttpClientRequest.post("/api/send-message").pipe(
              HttpClientRequest.bodyText(JSON.stringify(body), "application/json")
            ),
            timeoutMs
          )
        const first = yield* send(messageBody).pipe(Effect.result)
        if (first._tag === "Failure") {
          return {
            state: "uncertain",
            code: first.failure._tag === "SendblueTimeoutError" ? "timeout" : "network"
          } as const
        }
        let response = first.success
        if (
          claim.replyToMessageHandle !== undefined &&
          isSafeInlineReplyRejection(response.status)
        ) {
          const fallbackBody = {
            number: claim.number,
            from_number: claim.fromNumber,
            content: claim.smsSafeText
          }
          if (statusCallback !== undefined) {
            Object.assign(fallbackBody, { status_callback: statusCallback })
          }
          const fallback = yield* send(fallbackBody).pipe(Effect.result)
          if (fallback._tag === "Failure") {
            return {
              state: "uncertain",
              code: fallback.failure._tag === "SendblueTimeoutError" ? "timeout" : "network"
            } as const
          }
          response = fallback.success
        }
        if (response.status < 200 || response.status >= 300) {
          return classifyHttpFailure(response.status)
        }
        const parsed = yield* decode("send_message", response, SendResponse).pipe(Effect.result)
        return parsed._tag === "Failure"
          ? ({ state: "uncertain", code: "invalid_success_response" } as const)
          : ({ state: "accepted", providerMessageHandle: parsed.success.message_handle } as const)
      })

      const history = (isOutbound: boolean, window: InboundHistoryWindow) => {
        const request = HttpClientRequest.get("/api/v2/messages").pipe(
          HttpClientRequest.setUrlParams({
            is_outbound: String(isOutbound),
            limit: MESSAGE_PAGE_LIMIT,
            sendblue_number: window.sendblueNumber,
            sent_at_gte: window.since.toISOString(),
            sent_at_lte: window.until.toISOString()
          })
        )
        return execute("message_history", request, timeoutMs).pipe(
          Effect.flatMap((response) => requireOk("message_history", response)),
          Effect.flatMap((response) => decode("message_history", response, MessageList)),
          Effect.map((body) => body.data)
        )
      }

      const listWebhooks = execute(
        "list_webhooks",
        HttpClientRequest.get("/api/account/webhooks"),
        timeoutMs
      ).pipe(
        Effect.flatMap((response) => requireOk("list_webhooks", response)),
        Effect.flatMap((response) => decode("list_webhooks", response, WebhookList))
      )

      return SendblueProvider.of({
        sendMessage,
        sendReaction: (input) =>
          sendInteraction("/api/send-reaction", {
            from_number: input.fromNumber,
            message_handle: input.messageHandle,
            reaction: input.reaction
          }),
        sendTypingIndicator: (input) => {
          const body = {
            number: input.number,
            from_number: input.fromNumber,
            state: input.state
          }
          if (input.maxDurationMs !== undefined) {
            Object.assign(body, { max_duration_ms: input.maxDurationMs })
          }
          return sendInteraction("/api/send-typing-indicator", body)
        },
        getStatus: (handle) =>
          execute(
            "get_status",
            HttpClientRequest.get("/api/status").pipe(
              HttpClientRequest.setUrlParam("handle", handle)
            ),
            timeoutMs
          ).pipe(
            Effect.flatMap((response) => requireOk("get_status", response)),
            Effect.flatMap((response) => decode("get_status", response, StatusResponse))
          ),
        listInbound: (window) => history(false, window),
        listOutbound: (window) => history(true, window),
        hasLine: (sendblueNumber) =>
          execute("list_lines", HttpClientRequest.get("/api/lines"), timeoutMs).pipe(
            Effect.flatMap((response) => requireOk("list_lines", response)),
            Effect.flatMap((response) => decode("list_lines", response, LineList)),
            Effect.map((body) => body.numbers.includes(sendblueNumber))
          ),
        reconcileWebhooks: (required, checkOnly) =>
          Effect.gen(function* () {
            let current = yield* listWebhooks
            const secretMatches = yield* timingSafeEqual(
              current.webhooks.globalSecret ?? "",
              required.globalSecret
            )
            let plan = planWebhookReconciliation(current, required, secretMatches)
            if (plan.state !== "changes_required" || checkOnly) return plan
            for (const addition of plan.additions) {
              yield* execute(
                "add_webhook",
                HttpClientRequest.post("/api/account/webhooks").pipe(
                  HttpClientRequest.bodyText(
                    JSON.stringify({ webhooks: [addition.url], type: addition.type }),
                    "application/json"
                  )
                ),
                timeoutMs
              ).pipe(Effect.flatMap((response) => requireOk("add_webhook", response)))
            }
            current = yield* listWebhooks
            const verifiedSecret = yield* timingSafeEqual(
              current.webhooks.globalSecret ?? "",
              required.globalSecret
            )
            plan = planWebhookReconciliation(current, required, verifiedSecret)
            if (plan.state !== "converged") {
              return yield* new SendblueVerificationError({
                code: "webhook_verification_failed"
              })
            }
            return plan
          })
      })
    })
  )
}

export function timingSafeEqual(
  left: string,
  right: string,
  subtle: SubtleCrypto = crypto.subtle
): Effect.Effect<boolean, SendblueTransportError> {
  return Effect.tryPromise({
    try: async () => {
      const encoder = new TextEncoder()
      const [leftDigest, rightDigest] = await Promise.all([
        subtle.digest("SHA-256", encoder.encode(left)),
        subtle.digest("SHA-256", encoder.encode(right))
      ])
      const leftBytes = new Uint8Array(leftDigest)
      const rightBytes = new Uint8Array(rightDigest)
      let difference = 0
      for (let index = 0; index < leftBytes.length; index += 1) {
        difference |= leftBytes[index]! ^ rightBytes[index]!
      }
      return difference === 0
    },
    catch: (cause) => new SendblueTransportError({ operation: "timing_safe_equal", cause })
  })
}

export const sendblueProviderLayer = (options: SendblueProviderOptions) =>
  providerLayer(options).pipe(Layer.provide(FetchHttpClient.layer))

export const sendblueProviderTestLayer = (
  options: SendblueProviderOptions,
  fetch: typeof globalThis.fetch
) =>
  providerLayer(options).pipe(
    Layer.provide(
      FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)))
    )
  )
