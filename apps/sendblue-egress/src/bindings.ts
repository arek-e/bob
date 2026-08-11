import type { DeliveryResult } from "@bob/contracts/delivery"

export interface EgressBindings {
  CORE: Fetcher
  DELIVERY_RESULT_QUEUE: Queue<DeliveryResult>
  SENDBLUE_API_KEY_ID: string
  SENDBLUE_API_SECRET_KEY: string
  SENDBLUE_STATUS_CALLBACK_URL: string
  CORE_CALLER_SECRET: string
}
