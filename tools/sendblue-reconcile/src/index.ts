import { createAccountClient } from "@bob/sendblue/account"

import { ENV } from "./environment.generated.ts"

const checkOnly = process.argv.includes("--check")
const client = createAccountClient({
  apiKeyId: ENV.SENDBLUE_API_KEY_ID,
  apiSecretKey: ENV.SENDBLUE_API_SECRET_KEY
})

const plan = await client.reconcile(
  {
    receiveUrl: ENV.SENDBLUE_RECEIVE_WEBHOOK_URL,
    outboundUrl: ENV.SENDBLUE_OUTBOUND_WEBHOOK_URL,
    globalSecret: ENV.SENDBLUE_WEBHOOK_SIGNING_SECRET
  },
  checkOnly
)

console.log(
  JSON.stringify({
    mode: checkOnly ? "check" : "apply",
    valid: plan.valid,
    secretMatches: plan.secretMatches,
    receiveCount: plan.receiveCount,
    outboundCount: plan.outboundCount,
    additions: plan.additions
  })
)

if (!plan.valid || (!checkOnly && plan.additions.length > 0)) process.exitCode = 1
