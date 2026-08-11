import type { InboundJob } from "@bob/contracts/jobs"

export interface IngressBindings {
  CORE: Fetcher
  INBOUND_QUEUE: Queue<InboundJob>
  SENDBLUE_ACCOUNT_ID: string
  SENDBLUE_LINE_ID: string
  SENDBLUE_WEBHOOK_SIGNING_SECRET: string
  SENDBLUE_FROM_NUMBER: string
  SENDBLUE_ALLOWED_USER_NUMBER: string
  CORE_CALLER_SECRET: string
}
