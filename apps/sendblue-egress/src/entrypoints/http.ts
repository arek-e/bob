import { MessageInteractionCommand } from "@bob/contracts/interactions"
import { timingSafeEqual } from "@bob/sendblue/webhooks"
import { Schema } from "effect"

import type { EgressBindings } from "../bindings.ts"

import { composeEgress } from "../composition.ts"

export async function handleInteractionRequest(
  request: Request,
  bindings: EgressBindings
): Promise<Response> {
  const callerToken = request.headers.get("x-bob-caller-token") ?? ""
  if (!(await timingSafeEqual(callerToken, bindings.CORE_CALLER_SECRET))) {
    return Response.json({ error: "unauthorized" }, { status: 401 })
  }

  let command: MessageInteractionCommand
  try {
    command = Schema.decodeUnknownSync(MessageInteractionCommand)(await request.json())
  } catch {
    return Response.json({ error: "invalid_request" }, { status: 400 })
  }

  const client = composeEgress(bindings).ports.sendblue
  if (command.action === "stop") {
    const typing = await client.sendTypingIndicator({
      number: command.number,
      fromNumber: command.fromNumber,
      state: "stop"
    })
    return Response.json({ typing })
  }

  const [reaction, typing] = await Promise.all([
    command.react
      ? client.sendReaction({
          fromNumber: command.fromNumber,
          messageHandle: command.messageHandle,
          reaction: "like"
        })
      : Promise.resolve({ state: "skipped" as const }),
    client.sendTypingIndicator({
      number: command.number,
      fromNumber: command.fromNumber,
      state: "start",
      maxDurationMs: command.maxDurationMs
    })
  ])
  return Response.json({ reaction, typing })
}
