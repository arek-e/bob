import type { CoreDatabase } from "@bob/db-types"
import type { BetterAuthOptions } from "better-auth"

import type { OutboundJob } from "./jobs.ts"

export interface GeneralCoreBindings {
  ASSETS?: { readonly fetch: (request: Request) => Promise<Response> }
  AUTH_DATABASE: NonNullable<BetterAuthOptions["database"]>
  DB: CoreDatabase
  INBOUND_DEAD_LETTER_QUEUE_NAME: string
  DELIVERY_RESULT_QUEUE_NAME: string
  DELIVERY_RESULT_DEAD_LETTER_QUEUE_NAME: string
  OUTBOUND_DEAD_LETTER_QUEUE_NAME: string
  OUTBOUND_QUEUE?: {
    readonly send: (job: OutboundJob, options?: { readonly delaySeconds?: number }) => Promise<void>
  }
  OWNER_ID: string
  OWNER_TIME_ZONE: string
  DATA_KEK_ACTIVE_VERSION: string
  DATA_KEK_KEYRING_JSON: string
  DATA_LOOKUP_KEY: string
  INGRESS_CALLER_SECRET: string
  EGRESS_CALLER_SECRET: string
  CHANNEL_EGRESS_URL: string
  BETTER_AUTH_SECRET: string
  SETUP_TOKEN: string
  OWNER_ACCESS_EMAIL: string
  AGENT_CALLER_SECRET: string
  AGENT_URL: string
  AGENT_ADMIN_URL: string
  UI_BASE_URL: string
  BOB_MODEL: string
  BOB_PROVIDER: string
  BOB_RUN_TOKEN_BUDGET: number
  BOB_DAILY_TOKEN_BUDGET: number
  BOB_RELEASE_SHA?: string
  OTEL_EXPORTER_OTLP_ENDPOINT?: string
}

export interface CoreBindings extends GeneralCoreBindings {}
