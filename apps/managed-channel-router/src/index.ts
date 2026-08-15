import { decodeWebhookPayload, normalizeInbound, timingSafeEqual } from "@bob/sendblue/webhooks"
import { Schema } from "effect"

import type { ManagedChannelRouterBindings } from "./bindings.ts"

import { createControlPlaneClient, createInstanceIngress } from "./adapters.ts"
import { createD1ChannelRouteStore } from "./d1-store.ts"
import { createManagedChannelRouter, UnknownManagedSender } from "./router.ts"

const MAX_BODY_BYTES = 16 * 1024

const response = (code: string, status: number): Response =>
  Response.json(
    { code },
    { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } }
  )

const RouteRegistration = Schema.Struct({
  senderE164: Schema.String.check(Schema.isPattern(/^\+[1-9]\d{7,14}$/)),
  provisioningSubject: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9:_-]{16,200}$/))
})

const readBody = async (request: Request): Promise<string> => {
  const bytes = new Uint8Array(await request.arrayBuffer())
  if (bytes.byteLength > MAX_BODY_BYTES) throw new Error("body_too_large")
  return new TextDecoder().decode(bytes)
}

const senderLookup = async (key: string, account: string, line: string, sender: string) => {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )
  const digest = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    new TextEncoder().encode(`${account}\u0000${line}\u0000${sender}`)
  )
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

const composition = (bindings: ManagedChannelRouterBindings) => {
  for (const secret of [
    bindings.SENDBLUE_WEBHOOK_SIGNING_SECRET,
    bindings.ROUTE_LOOKUP_KEY,
    bindings.ROUTER_EVENT_KEY,
    bindings.ROUTER_ADMIN_TOKEN,
    bindings.CONTROL_PLANE_TOKEN,
    bindings.RUNTIME_INGRESS_TOKEN
  ]) {
    if (secret.length < 32) throw new Error("Managed Channel Router credential is invalid")
  }
  const store = createD1ChannelRouteStore(
    bindings.ROUTES,
    bindings.ROUTER_EVENT_KEY,
    bindings.ROUTER_EVENT_KEY_VERSION
  )
  return createManagedChannelRouter(
    store,
    createControlPlaneClient(bindings.CONTROL_PLANE_URL, bindings.CONTROL_PLANE_TOKEN, {
      region: bindings.MANAGED_REGION,
      isolationClass: bindings.MANAGED_ISOLATION_CLASS,
      resourcePolicyId: bindings.MANAGED_RESOURCE_POLICY_ID,
      releaseChannel: bindings.MANAGED_RELEASE_CHANNEL ?? "stable"
    }),
    createInstanceIngress(bindings.RUNTIME_INGRESS, bindings.RUNTIME_INGRESS_TOKEN),
    {
      send: async (eventId) => {
        await bindings.DELIVERY_QUEUE.send({ eventId })
      }
    }
  )
}

async function handleFetch(request: Request, bindings: ManagedChannelRouterBindings) {
  const url = new URL(request.url)
  if (request.method === "GET" && url.pathname === "/health") {
    return Response.json({ healthy: true, service: "managed-channel-router", version: 1 })
  }
  if (request.method === "POST" && url.pathname === "/v1/routes") {
    const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? ""
    if (!(await timingSafeEqual(supplied, bindings.ROUTER_ADMIN_TOKEN)))
      return response("unauthorized", 401)
    const body = Schema.decodeUnknownSync(RouteRegistration)(JSON.parse(await readBody(request)))
    const lookup = await senderLookup(
      bindings.ROUTE_LOOKUP_KEY,
      bindings.SENDBLUE_ACCOUNT_ID,
      bindings.SENDBLUE_LINE_ID,
      body.senderE164
    )
    const route = await composition(bindings).register(lookup, body.provisioningSubject)
    return Response.json({ routeId: route.id }, { status: 201 })
  }
  if (request.method !== "POST" || url.pathname !== "/webhooks/receive")
    return response("not_found", 404)
  const secret = request.headers.get("sb-signing-secret")
  if (secret === null || !(await timingSafeEqual(secret, bindings.SENDBLUE_WEBHOOK_SIGNING_SECRET)))
    return response("unauthorized", 401)
  try {
    const payload = decodeWebhookPayload(JSON.parse(await readBody(request)))
    if (payload.to_number !== bindings.SENDBLUE_FROM_NUMBER) return response("unknown_line", 403)
    const lookup = await senderLookup(
      bindings.ROUTE_LOOKUP_KEY,
      bindings.SENDBLUE_ACCOUNT_ID,
      bindings.SENDBLUE_LINE_ID,
      payload.from_number
    )
    const event = normalizeInbound(payload, {
      accountId: bindings.SENDBLUE_ACCOUNT_ID,
      lineId: bindings.SENDBLUE_LINE_ID
    })
    const accepted = await composition(bindings).accept(
      lookup,
      `${bindings.SENDBLUE_ACCOUNT_ID}:${bindings.SENDBLUE_LINE_ID}:${event.messageHandle}`,
      event
    )
    return response(accepted.duplicate ? "duplicate" : "accepted", 202)
  } catch (error) {
    if (error instanceof UnknownManagedSender) return response("not_allowed", 403)
    return response("invalid_request", 400)
  }
}

async function handleQueue(
  batch: MessageBatch<{ readonly eventId: string }>,
  bindings: ManagedChannelRouterBindings
) {
  const router = composition(bindings)
  await Promise.all(
    batch.messages.map(async (message) => {
      const result = await router.deliver(message.body.eventId)
      if (result === "retry") message.retry({ delaySeconds: 5 })
      else message.ack()
    })
  )
}

export default {
  fetch: handleFetch,
  queue: handleQueue
} satisfies ExportedHandler<ManagedChannelRouterBindings, { readonly eventId: string }>
