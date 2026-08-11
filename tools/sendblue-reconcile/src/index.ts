import { createAccountClient } from "@bob/sendblue/account"
import { createSendblueClient } from "@bob/sendblue/client"
import { createSendblueReadiness } from "@bob/sendblue/readiness"

import { ENV } from "./environment.generated.ts"

const checkOnly = process.argv.includes("--check")
const messageHandleFlag = process.argv.findIndex((argument) => argument === "--message-handle")
const messageHandle =
  process.argv.find((argument) => argument.startsWith("--message-handle="))?.slice(17) ??
  (messageHandleFlag === -1 ? undefined : process.argv[messageHandleFlag + 1])
const credentials = {
  apiKeyId: ENV.SENDBLUE_API_KEY_ID,
  apiSecretKey: ENV.SENDBLUE_API_SECRET_KEY
}

try {
  const report = await createSendblueReadiness({
    account: createAccountClient(credentials),
    delivery: createSendblueClient(credentials)
  }).run({
    requiredWebhooks: {
      receiveUrl: ENV.SENDBLUE_RECEIVE_WEBHOOK_URL,
      outboundUrl: ENV.SENDBLUE_OUTBOUND_WEBHOOK_URL,
      globalSecret: ENV.SENDBLUE_WEBHOOK_SIGNING_SECRET
    },
    messageHandle: messageHandle ?? "",
    checkOnly
  })

  console.log(
    JSON.stringify({
      mode: checkOnly ? "check" : "apply",
      readyForPing: report.readyForPing,
      ingressHealthUrl: report.ingressHealthUrl,
      webhooks: report.webhooks,
      deliveryStatus: report.deliveryStatus,
      nextAction: report.nextAction
    })
  )

  if (!report.readyForPing) process.exitCode = 1
} catch (error) {
  console.error(
    JSON.stringify({
      mode: checkOnly ? "check" : "apply",
      readyForPing: false,
      error: error instanceof Error ? error.message : "Unknown Sendblue readiness failure"
    })
  )
  process.exitCode = 1
}
