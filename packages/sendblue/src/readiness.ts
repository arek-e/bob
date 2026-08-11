import type { DeliveryReconciliationResult } from "@bob/contracts/delivery"

import { Schema } from "effect"

import type { ReconcilePlan, RequiredWebhooks } from "./account.ts"

const IngressHealth = Schema.Struct({
  healthy: Schema.Literal(true),
  service: Schema.Literal("sendblue-ingress"),
  version: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1))
})

interface AccountReadinessPort {
  reconcile(required: RequiredWebhooks, checkOnly: boolean): Promise<ReconcilePlan>
}

interface DeliveryReadinessPort {
  getStatus(messageHandle: string): Promise<DeliveryReconciliationResult>
}

export interface SendblueReadinessOptions {
  readonly account: AccountReadinessPort
  readonly delivery: DeliveryReadinessPort
  readonly fetch?: typeof fetch
  readonly timeoutMs?: number
}

export interface SendblueReadinessInput {
  readonly requiredWebhooks: RequiredWebhooks
  readonly messageHandle: string
  readonly checkOnly: boolean
}

export interface SendblueReadinessReport {
  readonly ingressHealthUrl: string
  readonly webhooks: ReconcilePlan
  readonly deliveryStatus?: DeliveryReconciliationResult
  readonly readyForPing: boolean
  readonly nextAction: string
}

function healthUrl(receiveUrl: string, outboundUrl: string): string {
  const receive = new URL(receiveUrl)
  const outbound = new URL(outboundUrl)
  if (receive.protocol !== "https:" || outbound.protocol !== "https:") {
    throw new Error("Sendblue webhook URLs must use HTTPS")
  }
  if (receive.origin !== outbound.origin) {
    throw new Error("Sendblue webhook URLs must use one ingress origin")
  }
  return new URL("/health", receive.origin).href
}

function incompleteAction(plan: ReconcilePlan, checkOnly: boolean): string {
  if (!plan.secretMatches) return "Match the Sendblue global secret, then run this check again."
  if (plan.receiveCount > 1 || plan.outboundCount > 1) {
    return "Remove duplicate Bob webhook endpoints, then run this check again."
  }
  return checkOnly
    ? "Run the apply command to add the missing Bob webhook endpoints."
    : "Add the missing Bob webhook endpoints, then run this check again."
}

export function createSendblueReadiness(options: SendblueReadinessOptions) {
  const request = options.fetch ?? fetch
  const timeoutMs = options.timeoutMs ?? 10_000

  return {
    async run(input: SendblueReadinessInput): Promise<SendblueReadinessReport> {
      if (input.messageHandle.trim().length === 0) {
        throw new Error("A Sendblue readiness message handle is required")
      }
      const ingressHealthUrl = healthUrl(
        input.requiredWebhooks.receiveUrl,
        input.requiredWebhooks.outboundUrl
      )
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort("sendblue_readiness_timeout"), timeoutMs)
      try {
        const response = await request(ingressHealthUrl, {
          headers: { accept: "application/json" },
          signal: controller.signal
        })
        if (!response.ok) throw new Error(`Sendblue ingress health failed: ${response.status}`)
        Schema.decodeUnknownSync(IngressHealth)(await response.json())
      } finally {
        clearTimeout(timeout)
      }

      const webhooks = await options.account.reconcile(input.requiredWebhooks, input.checkOnly)
      if (!webhooks.complete) {
        return {
          ingressHealthUrl,
          webhooks,
          readyForPing: false,
          nextAction: incompleteAction(webhooks, input.checkOnly)
        }
      }

      const deliveryStatus = await options.delivery.getStatus(input.messageHandle)
      return {
        ingressHealthUrl,
        webhooks,
        deliveryStatus,
        readyForPing: true,
        nextAction: "Ask the allowlisted owner to send PING."
      }
    }
  }
}
