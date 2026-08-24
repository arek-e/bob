import type { CoreBindings } from "@bob/core-types/bindings"

import { authorizeCoreRequest } from "@bob/policy-service/access"
import { createOwnerAuth } from "@bob/policy-service/auth/service"
import { Effect } from "effect"

import type { CoreComposer, CoreRuntimeRequirements } from "../composition.ts"

import { authenticateOwnerApiRequest } from "../http/authentication.ts"
import { readAttachmentBytes, readJson, idempotencyKey } from "../http/body.ts"
import { errorResponse } from "../http/errors.ts"
import { json, secure } from "../http/response.ts"
import { handleInternalRequest } from "../http/routes/internal/index.ts"
import { handleOwnerRequest } from "../http/routes/owner/index.ts"
import { handleOwnerEnrollment, handleSetup } from "../http/setup.ts"

export async function handleHttp(
  request: Request,
  bindings: CoreBindings,
  compose?: CoreComposer
): Promise<Response> {
  const url = new URL(request.url)
  if (request.method === "GET" && url.pathname === "/health") {
    return json({ healthy: true, service: "core-runtime", version: 1 })
  }

  if (url.pathname === "/api/auth" || url.pathname.startsWith("/api/auth/")) {
    return secure(await createOwnerAuth(bindings).handler(request))
  }

  if (url.pathname === "/setup/api") {
    if (compose === undefined) throw new Error("Core composition is required")
    return handleSetup(request, bindings, compose)
  }

  if (url.pathname === "/internal/owners/enroll") {
    if (compose === undefined) throw new Error("Core composition is required")
    return handleOwnerEnrollment(request, bindings, compose)
  }

  let ownerId: string | undefined
  if (url.pathname.startsWith("/api/")) {
    const authenticated = await authenticateOwnerApiRequest(request, url, bindings)
    if (authenticated instanceof Response) return authenticated
    ownerId = authenticated
  } else if (url.pathname.startsWith("/internal/")) {
    try {
      await authorizeCoreRequest(request, {
        ingressSecret: bindings.INGRESS_CALLER_SECRET,
        egressSecret: bindings.EGRESS_CALLER_SECRET,
        agentSecret: bindings.AGENT_CALLER_SECRET,
        operatorSecret: bindings.PRODUCTION_DATA_INSPECTOR_SECRET
      })
    } catch {
      return json({ code: "unauthorized" }, 401)
    }
  } else {
    if (bindings.ASSETS !== undefined) return bindings.ASSETS.fetch(request)
    return json({ code: "not_found" }, 404)
  }

  try {
    if (compose === undefined) throw new Error("Core composition is required")
    const composition = compose(bindings)
    const runTelemetry = <A, E, R extends CoreRuntimeRequirements>(
      effect: Effect.Effect<A, E, R>
    ) => composition.runtime.runPromise(effect)
    const context = {
      request,
      url,
      bindings,
      composition,
      runTelemetry,
      jobQueue() {
        const jobs = composition.jobQueue
        if (jobs === undefined) throw new Error("Job Queue is required")
        return jobs
      },
      readJson: () => readJson(request),
      readAttachmentBytes: () => readAttachmentBytes(request),
      idempotencyKey: () => idempotencyKey(request)
    }

    const response =
      ownerId === undefined
        ? await handleInternalRequest(context)
        : await handleOwnerRequest({ ...context, ownerId })
    return response ?? json({ code: "not_found" }, 404)
  } catch (error) {
    return errorResponse(error instanceof Error ? error : new Error("request_failed"))
  }
}
