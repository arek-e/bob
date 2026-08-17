import type { DeliveryResult } from "@bob/delivery-types/delivery"

import type { RuntimeFetcher, RuntimeQueue } from "../runtime.ts"

export interface EgressBindings {
  CORE: RuntimeFetcher
  INGRESS: RuntimeFetcher
  DELIVERY_RESULT_QUEUE: RuntimeQueue<DeliveryResult>
  SENDBLUE_WEBHOOK_SIGNING_SECRET: string
  SENDBLUE_FROM_NUMBER: string
  SENDBLUE_ALLOWED_USER_NUMBER: string
  SENDBLUE_STATUS_CALLBACK_URL: string
  CORE_CALLER_SECRET: string
}
