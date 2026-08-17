import type { InboundJob } from "@bob/core-types/jobs"

import type { RuntimeFetcher, RuntimeQueue } from "../runtime.ts"

export interface IngressBindings {
  CORE: RuntimeFetcher
  MEDIA: RuntimeFetcher
  INBOUND_QUEUE: RuntimeQueue<InboundJob>
  SENDBLUE_ACCOUNT_ID: string
  SENDBLUE_LINE_ID: string
  SENDBLUE_WEBHOOK_SIGNING_SECRET: string
  SENDBLUE_FROM_NUMBER: string
  CORE_CALLER_SECRET: string
  SENDBLUE_MEDIA_HOSTS: string
}
