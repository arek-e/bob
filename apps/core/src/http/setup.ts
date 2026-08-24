import type { CoreBindings } from "@bob/core-types/bindings"

import { ConversationStore } from "@bob/conversations-types/store"
import { authorizeOwnerEnrollmentRequest, authorizeSetupRequest } from "@bob/policy-service/access"
import { createOwnerAuth } from "@bob/policy-service/auth/service"
import { OwnerDataKeyStore } from "@bob/policy-types/owner-data-key"
import { sql } from "drizzle-orm"
import { Effect, Schema } from "effect"

import type { CoreComposer } from "../composition.ts"

import { readJson } from "./body.ts"
import { json, secure } from "./response.ts"

async function authUserExists(bindings: CoreBindings): Promise<boolean> {
  const rows = await Effect.runPromise(
    bindings.DB.execute<{ id: string }>(sql`SELECT id FROM auth_user LIMIT 1`, "objects")
  )
  return rows.length > 0
}

export async function handleSetup(
  request: Request,
  bindings: CoreBindings,
  compose: CoreComposer
): Promise<Response> {
  const ownerId = bindings.OWNER_ID
  const ownerEmail = bindings.OWNER_ACCESS_EMAIL
  if (ownerId === undefined || ownerEmail === undefined) {
    return json({ code: "legacy_setup_disabled" }, 404)
  }
  try {
    await authorizeSetupRequest(request, { setupToken: bindings.SETUP_TOKEN })
  } catch {
    return json({ code: "unauthorized" }, 401)
  }

  if (request.method === "GET") {
    return json({ setupRequired: !(await authUserExists(bindings)) })
  }
  if (request.method !== "POST") return json({ code: "method_not_allowed" }, 405)
  if (await authUserExists(bindings)) return json({ code: "setup_complete" }, 409)

  let value: typeof Schema.Json.Type
  try {
    value = await readJson(request)
  } catch {
    return json({ code: "invalid_request" }, 400)
  }
  const passwordResult = Schema.decodeUnknownExit(
    Schema.Struct({
      password: Schema.String.check(Schema.isMinLength(12), Schema.isMaxLength(128))
    })
  )(value)
  if (passwordResult._tag === "Failure") {
    return json({ code: "invalid_password" }, 400)
  }
  const password = passwordResult.value.password
  const composition = compose(bindings)
  await composition.runtime.runPromise(
    Effect.flatMap(OwnerDataKeyStore, (ownerDataKeys) => ownerDataKeys.ensure(ownerId))
  )

  const headers = new Headers(request.headers)
  headers.delete("content-length")
  headers.set("content-type", "application/json")
  const signupRequest = new Request(new URL("/api/auth/sign-up/email", request.url), {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: "Owner",
      email: ownerEmail,
      password
    })
  })
  return secure(
    await createOwnerAuth(bindings, {
      allowSignUp: true,
      allowedEmail: ownerEmail,
      ownerId
    }).handler(signupRequest)
  )
}

export async function handleOwnerEnrollment(
  request: Request,
  bindings: CoreBindings,
  compose: CoreComposer
): Promise<Response> {
  if (request.method !== "POST") return json({ code: "method_not_allowed" }, 405)
  try {
    await authorizeOwnerEnrollmentRequest(request, {
      ownerEnrollmentSecret: bindings.OWNER_ENROLLMENT_SECRET
    })
  } catch {
    return json({ code: "unauthorized" }, 401)
  }

  const input = Schema.decodeUnknownSync(
    Schema.Struct({
      ownerId: Schema.String.check(Schema.isUUID()),
      email: Schema.String.check(Schema.isMinLength(3), Schema.isMaxLength(320)),
      password: Schema.String.check(Schema.isMinLength(12), Schema.isMaxLength(128)),
      channel: Schema.Struct({
        accountId: Schema.String.check(Schema.isMinLength(1)),
        lineId: Schema.String.check(Schema.isMinLength(1)),
        senderE164: Schema.String.check(Schema.isPattern(/^\+[1-9]\d{7,14}$/)),
        destinationE164: Schema.String.check(Schema.isPattern(/^\+[1-9]\d{7,14}$/))
      })
    })
  )(await readJson(request))
  const normalizedEmail = input.email.trim().toLowerCase()
  const existingOwners = await Effect.runPromise(
    bindings.DB.execute<{ id: string; email: string }>(
      sql`SELECT id, email FROM auth_user WHERE id = ${input.ownerId} OR lower(email) = ${normalizedEmail}`,
      "objects"
    )
  )
  let conflict: { readonly id: string; readonly email: string } | undefined
  for (const owner of existingOwners) {
    if (owner.id !== input.ownerId || owner.email.trim().toLowerCase() !== normalizedEmail) {
      conflict = owner
      break
    }
  }
  if (conflict !== undefined) return json({ code: "owner_identity_conflict" }, 409)
  if (existingOwners.length === 0) {
    const headers = new Headers(request.headers)
    headers.delete("content-length")
    headers.set("content-type", "application/json")
    const response = await createOwnerAuth(bindings, {
      allowSignUp: true,
      allowedEmail: normalizedEmail,
      ownerId: input.ownerId
    }).handler(
      new Request(new URL("/api/auth/sign-up/email", request.url), {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "Owner", email: normalizedEmail, password: input.password })
      })
    )
    if (!response.ok) return secure(response)
  }
  const composition = compose(bindings)
  await composition.runtime.runPromise(
    Effect.flatMap(OwnerDataKeyStore, (ownerDataKeys) => ownerDataKeys.ensure(input.ownerId))
  )
  await composition.runtime.runPromise(
    Effect.flatMap(ConversationStore, (conversations) =>
      conversations.bindChannel({ ownerId: input.ownerId, ...input.channel })
    )
  )
  return json({ ownerId: input.ownerId, state: "active" }, 201)
}
