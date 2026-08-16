import type { InboundJob } from "@bob/contracts/jobs"

import type { RuntimeFetcher, RuntimeQueue } from "../../src/runtime.ts"

export interface IngressBindings {
  CORE: RuntimeFetcher
  INBOUND_QUEUE: RuntimeQueue<InboundJob>
  SENDBLUE_ACCOUNT_ID: string
  SENDBLUE_LINE_ID: string
  SENDBLUE_WEBHOOK_SIGNING_SECRET: string
  SENDBLUE_FROM_NUMBER: string
  SENDBLUE_ALLOWED_USER_NUMBER: string
  CORE_CALLER_SECRET: string
  OTEL_EXPORTER_OTLP_ENDPOINT: string
  BOB_RELEASE_SHA: string
}
