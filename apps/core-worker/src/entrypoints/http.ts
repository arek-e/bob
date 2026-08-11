import { AgentRunResult } from "@bob/contracts/agent"
import { NormalizedInboundEvent, NormalizedStatusEvent } from "@bob/contracts/channel"
import { DeliveryResult } from "@bob/contracts/delivery"
import { JournalEntryCreate, TrainingProposalApproval } from "@bob/contracts/ui"
import { Schema } from "effect"

import type { CoreBindings } from "../bindings.ts"
import { composeCore } from "../composition.ts"
import { authorizeCoreRequest } from "../modules/policy/access.ts"

const MAX_BODY_BYTES = 64 * 1024
const securityHeaders = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff"
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: securityHeaders })
}

async function readJson(request: Request): Promise<unknown> {
  const declaredLength = Number(request.headers.get("content-length") ?? "0")
  if (declaredLength > MAX_BODY_BYTES) throw new Error("body_too_large")
  const bytes = new Uint8Array(await request.arrayBuffer())
  if (bytes.byteLength > MAX_BODY_BYTES) throw new Error("body_too_large")
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown
}

function idempotencyKey(request: Request): string {
  const value = request.headers.get("idempotency-key")
  if (value === null || value.length < 8 || value.length > 200) {
    throw new Error("A valid idempotency key is required")
  }
  return value
}

export async function handleHttp(request: Request, bindings: CoreBindings): Promise<Response> {
  const url = new URL(request.url)
  if (request.method === "GET" && url.pathname === "/health") {
    return json({ healthy: true, service: "core", version: 1 })
  }

  try {
    await authorizeCoreRequest(request, {
      ingressSecret: bindings.INGRESS_CALLER_SECRET,
      egressSecret: bindings.EGRESS_CALLER_SECRET,
      ownerEmail: bindings.OWNER_ACCESS_EMAIL,
      agentSubject: bindings.AGENT_CALLER_SUBJECT,
      accessIssuer: `https://${bindings.ACCESS_TEAM_DOMAIN}`,
      accessAudience: bindings.CORE_ACCESS_AUDIENCE
    })
  } catch {
    return json({ code: "unauthorized" }, 401)
  }

  try {
    const composition = composeCore(bindings)

    if (request.method === "POST" && url.pathname === "/internal/inbound") {
      const event = Schema.decodeUnknownSync(NormalizedInboundEvent)(await readJson(request))
      return json(await composition.services.conversations.acceptInbound(event))
    }

    const inboundEnqueued = url.pathname.match(/^\/internal\/inbound\/([^/]+)\/enqueued$/)
    if (request.method === "POST" && inboundEnqueued !== null) {
      await composition.services.conversations.markEnqueued(
        decodeURIComponent(inboundEnqueued[1]!),
        new Date().toISOString()
      )
      return json({ ok: true })
    }

    if (request.method === "POST" && url.pathname === "/internal/status") {
      const event = Schema.decodeUnknownSync(NormalizedStatusEvent)(await readJson(request))
      await composition.services.delivery.recordProviderEvent(event)
      return json({ ok: true })
    }

    const outboxClaim = url.pathname.match(/^\/internal\/outbox\/([^/]+)\/claim$/)
    if (request.method === "POST" && outboxClaim !== null) {
      const claim = await composition.services.delivery.claimOutbox(
        decodeURIComponent(outboxClaim[1]!),
        60_000
      )
      return claim === undefined
        ? json(
            {
              claim: null,
              disposition: await composition.services.delivery.outboxDisposition(
                decodeURIComponent(outboxClaim[1]!)
              )
            },
            409
          )
        : json(claim)
    }

    const outboxResult = url.pathname.match(/^\/internal\/outbox\/([^/]+)\/result$/)
    if (request.method === "POST" && outboxResult !== null) {
      const result = Schema.decodeUnknownSync(DeliveryResult)(await readJson(request))
      if (result.outboxId !== decodeURIComponent(outboxResult[1]!))
        return json({ code: "id_mismatch" }, 400)
      await composition.services.delivery.recordResult(result)
      return json({ ok: true })
    }

    if (request.method === "POST" && url.pathname === "/internal/tools") {
      return json(await composition.services.tools.execute(await readJson(request)))
    }

    if (request.method === "GET" && url.pathname === "/api/reminders") {
      return json({
        reminders: await composition.services.reminders.list(composition.config.OWNER_ID)
      })
    }

    if (request.method === "GET" && url.pathname === "/api/alerts") {
      return json({
        alerts: await composition.services.alerts.list(composition.config.OWNER_ID)
      })
    }

    const alertReconcile = url.pathname.match(/^\/api\/alerts\/([^/]+)\/reconcile$/)
    if (request.method === "POST" && alertReconcile !== null) {
      idempotencyKey(request)
      const alertId = decodeURIComponent(alertReconcile[1]!)
      const alert = await composition.services.alerts.get(composition.config.OWNER_ID, alertId)
      if (alert === undefined) return json({ code: "not_found" }, 404)
      await composition.services.alerts.setState(
        composition.config.OWNER_ID,
        alert.id,
        "reconciling"
      )
      if (alert.code === "inbound_exhausted") {
        const decision = await composition.services.conversations.prepareInboundRecovery(
          alert.objectId,
          4
        )
        if (decision === "recover") {
          await bindings.INBOUND_QUEUE.send({ eventId: alert.objectId })
          await composition.services.conversations.markEnqueued(
            alert.objectId,
            new Date().toISOString()
          )
          await composition.services.alerts.setState(
            composition.config.OWNER_ID,
            alert.id,
            "resolved"
          )
        }
        return json({ status: decision })
      }
      if (alert.code === "delivery_uncertain" || alert.code === "delivery_result_exhausted") {
        const status = await composition.services.delivery.reconcileOutbox(alert.objectId)
        if (status === "resolved") {
          await composition.services.alerts.setState(
            composition.config.OWNER_ID,
            alert.id,
            "resolved"
          )
        }
        return json({ status })
      }
      if (alert.code === "agent_authentication_failed") {
        const response = await fetch(`${composition.config.AGENT_ADMIN_URL}/v1/admin/auth/status`, {
          headers: {
            "CF-Access-Client-Id": composition.config.AGENT_ADMIN_ACCESS_CLIENT_ID,
            "CF-Access-Client-Secret": composition.config.AGENT_ADMIN_ACCESS_CLIENT_SECRET
          }
        })
        const status = (await response.json()) as { configured?: boolean }
        if (response.ok && status.configured === true) {
          await composition.services.alerts.setState(
            composition.config.OWNER_ID,
            alert.id,
            "resolved"
          )
        }
        return json({ status: status.configured === true ? "resolved" : "pending" })
      }
      await composition.services.alerts.setState(composition.config.OWNER_ID, alert.id, "resolved")
      return json({ status: "manual_action_required" })
    }

    if (request.method === "POST" && url.pathname === "/api/journal/handoffs") {
      const handoff = await composition.services.journal.createHandoff(
        composition.config.OWNER_ID,
        10 * 60_000,
        idempotencyKey(request)
      )
      return json({
        id: handoff.id,
        expiresAt: handoff.expiresAt,
        path: `/journal/${handoff.id}`,
        bearerToken: false
      })
    }

    if (request.method === "POST" && url.pathname === "/api/journal") {
      const input = Schema.decodeUnknownSync(JournalEntryCreate)(await readJson(request))
      const id = await composition.services.journal.createEntry(
        {
          ownerId: composition.config.OWNER_ID,
          handoffId: input.handoffId,
          text: input.text,
          tags: input.tags,
          ...(input.approvedSummary === undefined ? {} : { approvedSummary: input.approvedSummary })
        },
        idempotencyKey(request)
      )
      return json({ id }, 201)
    }

    if (request.method === "GET" && url.pathname === "/api/journal") {
      const tag = url.searchParams.get("tag") ?? undefined
      return json({
        entries: await composition.services.journal.searchMetadata(composition.config.OWNER_ID, tag)
      })
    }

    if (request.method === "GET" && url.pathname === "/api/memory/candidates") {
      return json({
        candidates: await composition.services.memory.listCandidates(composition.config.OWNER_ID)
      })
    }

    const memoryConfirm = url.pathname.match(/^\/api\/memory\/candidates\/([^/]+)\/confirm$/)
    if (request.method === "POST" && memoryConfirm !== null) {
      const revisionId = await composition.services.memory.confirm(
        composition.config.OWNER_ID,
        decodeURIComponent(memoryConfirm[1]!),
        "owner_ui",
        idempotencyKey(request)
      )
      return json({ revisionId })
    }

    if (request.method === "GET" && url.pathname === "/api/training/proposals") {
      return json({
        proposals: await composition.services.tools.listTrainingProposals(
          composition.config.OWNER_ID
        )
      })
    }

    const trainingApprove = url.pathname.match(/^\/api\/training\/proposals\/([^/]+)\/approve$/)
    if (request.method === "POST" && trainingApprove !== null) {
      const input = Schema.decodeUnknownSync(TrainingProposalApproval)(await readJson(request))
      return json(
        await composition.services.tools.approveTrainingProposal(
          composition.config.OWNER_ID,
          decodeURIComponent(trainingApprove[1]!),
          input.proposalHash,
          idempotencyKey(request)
        )
      )
    }

    const journalEntry = url.pathname.match(/^\/api\/journal\/([^/]+)$/)
    if (request.method === "GET" && journalEntry !== null) {
      const entry = await composition.services.journal.readEntry(
        composition.config.OWNER_ID,
        decodeURIComponent(journalEntry[1]!)
      )
      return entry === undefined ? json({ code: "not_found" }, 404) : json(entry)
    }

    const journalDelete = journalEntry
    if (request.method === "DELETE" && journalDelete !== null) {
      await composition.services.journal.deleteEntry(
        composition.config.OWNER_ID,
        decodeURIComponent(journalDelete[1]!),
        idempotencyKey(request)
      )
      return json({ ok: true })
    }

    if (request.method === "GET" && url.pathname === "/api/agent/status") {
      const response = await fetch(`${composition.config.AGENT_ADMIN_URL}/v1/admin/auth/status`, {
        headers: {
          "CF-Access-Client-Id": composition.config.AGENT_ADMIN_ACCESS_CLIENT_ID,
          "CF-Access-Client-Secret": composition.config.AGENT_ADMIN_ACCESS_CLIENT_SECRET
        }
      })
      return json(await response.json(), response.status)
    }

    if (request.method === "POST" && url.pathname === "/api/agent/device-login") {
      const response = await fetch(
        `${composition.config.AGENT_ADMIN_URL}/v1/admin/auth/device-login`,
        {
          method: "POST",
          headers: {
            "CF-Access-Client-Id": composition.config.AGENT_ADMIN_ACCESS_CLIENT_ID,
            "CF-Access-Client-Secret": composition.config.AGENT_ADMIN_ACCESS_CLIENT_SECRET
          }
        }
      )
      return json(await response.json(), response.status)
    }

    if (request.method === "POST" && url.pathname === "/internal/agent/result") {
      Schema.decodeUnknownSync(AgentRunResult)(await readJson(request))
      return json({ ok: true })
    }
    if (bindings.ASSETS !== undefined && !url.pathname.startsWith("/internal/")) {
      return bindings.ASSETS.fetch(request)
    }
    return json({ code: "not_found" }, 404)
  } catch (error) {
    const status = error instanceof Error && error.message === "body_too_large" ? 413 : 400
    return json({ code: status === 413 ? "body_too_large" : "invalid_request" }, status)
  }
}
