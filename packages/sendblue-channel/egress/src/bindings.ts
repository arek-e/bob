import type { DeliveryResult } from "@bob/delivery-types/delivery"

import type { RuntimeFetcher, RuntimeQueue } from "../../src/runtime.ts"

export interface EgressBindings {
  CORE: RuntimeFetcher
  INGRESS: RuntimeFetcher
  DELIVERY_RESULT_QUEUE: RuntimeQueue<DeliveryResult>
  SENDBLUE_API_KEY_ID: string
  SENDBLUE_API_SECRET_KEY: string
  SENDBLUE_WEBHOOK_SIGNING_SECRET: string
  SENDBLUE_FROM_NUMBER: string
  SENDBLUE_ALLOWED_USER_NUMBER: string
  SENDBLUE_STATUS_CALLBACK_URL: string
  CORE_CALLER_SECRET: string
  OTEL_EXPORTER_OTLP_ENDPOINT: string
  BOB_RELEASE_SHA: string
}
