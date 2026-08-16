import type { DeliveryResult } from "@bob/contracts/delivery"

export interface EgressBindings {
  CORE: Fetcher
  INGRESS: Fetcher
  DELIVERY_RESULT_QUEUE: Queue<DeliveryResult>
  SENDBLUE_API_KEY_ID: string
  SENDBLUE_API_SECRET_KEY: string
  SENDBLUE_WEBHOOK_SIGNING_SECRET: string
  SENDBLUE_FROM_NUMBER: string
  SENDBLUE_ALLOWED_USER_NUMBER: string
  SENDBLUE_STATUS_CALLBACK_URL: string
  CORE_CALLER_SECRET: string
  OTEL_EXPORTER_OTLP_ENDPOINT: string
  OTEL_ACCESS_CLIENT_ID: string
  OTEL_ACCESS_CLIENT_SECRET: string
  BOB_RELEASE_SHA: string
}
