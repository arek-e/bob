import {
  DeliveryReconciliationRequest,
  DeliveryReconciliationResult
} from "@bob/contracts/delivery"
import { createSendblueClient } from "@bob/sendblue/client"
import { timingSafeEqual } from "@bob/sendblue/webhooks"
import { Schema } from "effect"

import type { EgressBindings } from "../bindings.ts"

const MAX_BODY_BYTES = 4 * 1024
const responseHeaders = {
  "cache-control": "no-store",
  "content-type": "application/json",
  "x-content-type-options": "nosniff"
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: responseHeaders })
}

async function readJson(request: Request): Promise<unknown> {
  const declaredLength = Number(request.headers.get("content-length") ?? "0")
  if (declaredLength > MAX_BODY_BYTES) throw new Error("body_too_large")
  const bytes = new Uint8Array(await request.arrayBuffer())
  if (bytes.byteLength > MAX_BODY_BYTES) throw new Error("body_too_large")
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown
}

export async function handleEgressHttp(
  request: Request,
  bindings: EgressBindings
): Promise<Response> {
  const url = new URL(request.url)
  if (request.method === "GET" && url.pathname === "/health") {
    return json({ healthy: true, service: "sendblue-egress", version: 1 })
  }
  if (request.method !== "POST" || url.pathname !== "/internal/reconcile") {
    return json({ code: "not_found" }, 404)
  }

  const suppliedSecret = request.headers.get("x-bob-caller-token")
  if (
    suppliedSecret === null ||
    !(await timingSafeEqual(suppliedSecret, bindings.CORE_CALLER_SECRET))
  ) {
    return json({ code: "unauthorized" }, 401)
  }

  let input: typeof DeliveryReconciliationRequest.Type
  try {
    input = Schema.decodeUnknownSync(DeliveryReconciliationRequest)(await readJson(request))
  } catch (error) {
    return json(
      {
        code:
          error instanceof Error && error.message === "body_too_large"
            ? "body_too_large"
            : "invalid_request"
      },
      error instanceof Error && error.message === "body_too_large" ? 413 : 400
    )
  }

  try {
    const result = await createSendblueClient({
      apiKeyId: bindings.SENDBLUE_API_KEY_ID,
      apiSecretKey: bindings.SENDBLUE_API_SECRET_KEY
    }).getStatus(input.messageHandle)
    return json(Schema.decodeUnknownSync(DeliveryReconciliationResult)(result))
  } catch {
    return json({ code: "provider_unavailable" }, 503)
  }
}
