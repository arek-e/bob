# ADR 0007: Machine authentication for the owner API

Status: Accepted
Date: 2026-08-24

## Context

Bob's private UI is a browser client for setup, review, and recovery. Automation agents need a stable machine
authentication method and must not depend on browser cookies or a human sign-in. Core already owns the Conversation and
Operations Application Module Interfaces. The owner API is the canonical HTTP boundary for resource access.

The Runtime Cluster can contain more than one Owner. A machine credential that accepts an Owner ID from the request
would allow a caller to cross the ownership boundary. The operator inspection secret is also intentionally metadata
only and must not become a message-content credential.

## Decision

Keep agent access on the canonical owner API. The machine-authenticated read uses the same route and handler as the
browser client:

- `GET /api/production-data/messages?from=<iso>&to=<iso>&limit=<1-100>` returns bounded message content for one
  configured Owner.

The route accepts either a Better Auth owner session or a standard `Authorization: Bearer <api-key>` credential. The
bearer credential is an authentication adapter at the HTTP boundary. It does not create a second agent API, resource
model, or data access path. Operator activity metadata remains on the existing `/internal/production-data/*` routes;
those routes are not part of the machine owner API.

Require a standard `Authorization: Bearer <api-key>` header. Read the key from `BOB_HEADLESS_API_KEY`, which the
deployment projects from the OpenBao `ops/apps/prod/bob/runtime-cluster` KV record to Core. Keep this credential
separate from internal caller secrets, operator inspection secrets, Better Auth secrets, and Agent Worker provider
credentials.

Bind message access to the deployment's explicit `BOB_HEADLESS_OWNER_ID`. Do not accept an Owner ID from the caller.
If no Owner scope is configured, the bearer credential receives `owner_scope_required` for message content. A machine
credential is not automatically valid for every owner route; each route keeps its own authorization policy.

Use the existing `ProductionDataInspector` and `ConversationStore` Interfaces. Keep the existing query limits: a
maximum 31-day window and at most 100 rows per request. Do not add mutation routes, arbitrary SQL, ciphertext access,
provider handles, private Agent payloads, or cross-owner message exports.

## Consequences

Agents can use Bob without loading the UI or maintaining a Better Auth session. The canonical owner API remains aligned
with the real application Modules, so it does not create a second HTTP contract or data access path.

The first version supports one configured Owner scope per Core environment. A future multi-client credential registry
must keep the same explicit scope model and add revocation, expiry, and per-client audit data before it supports more
than one scope.

OpenBao stores the bearer credential, while Core receives it through the deployment environment projection. Key
rotation therefore requires an OpenBao update and a Core restart or redeploy. The API must remain on private ingress
and receive edge rate limits before external automation uses it. A later OAuth/OIDC client-credentials integration can
replace the static bearer credential without changing resource routes or Application Module Interfaces.
