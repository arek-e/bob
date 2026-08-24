# ADR 0004: Bounded production data inspection

Status: Accepted
Date: 2026-08-23

## Context

Operators need to understand message volume, Agent Run state, Tool activity, and delivery failures in the
production Runtime. Coolify manages the Runtime Cluster, but it is not the application data authority and its
resource views do not show PostgreSQL rows.

The application stores message and Agent Run payloads as private data. A general SQL endpoint or an operator
endpoint that decrypts all Owner data would bypass the existing privacy and ownership boundaries. The maintenance
CLI also needs to run repository operations without depending on a deployed Core HTTP process.

## Decision

Add a production data inspector to the Operations Application Module. It exposes two internal, read-only
operations:

- a bounded time-window summary of counts and pseudonymous owner interaction aggregates;
- bounded workflow metadata for one correlation ID.

Protect the internal HTTP operations with a dedicated `PRODUCTION_DATA_INSPECTOR_SECRET`. Keep this secret
separate from ingress, egress, and Agent caller secrets. Select only status, timing, model, Tool name, and opaque
record references. Do not select message ciphertext, private snapshots, Tool arguments or results, provider
handles, phone numbers, idempotency keys, or credentials.

Expose owner API message content through the canonical `/api/production-data/messages` route. The route accepts either
the existing Better Auth owner-session boundary or the scoped machine credential defined in ADR 0007. Limit every
query to a bounded time window and result count. The operator secret cannot authorize the content route. The direct
maintenance runtime may call the existing `ConversationStore.listMessages` Interface for one explicit owner when the
operator supplies the separate content approval guardrail described in ADR 0005.

Keep PostgreSQL authoritative. Do not add arbitrary SQL, runtime discovery, a Coolify database tunnel, or an
Argo migration. The Control Plane and Coolify continue to own deployment, health, release, and backup actions.

## Consequences

Operators can inspect production interaction and failure shape without receiving private message content.
Owners and approved automation clients can read bounded messages through the same authenticated API route.

The Runtime release needs a `PRODUCTION_DATA_INSPECTOR_SECRET` projection for the Core consumer. OpenBao must
provide the value before the release becomes ready. A deployment that omits the projection fails Core
configuration validation instead of silently exposing an unauthenticated route.

The inspector adds bounded PostgreSQL reads to Core. These reads are metadata-only and do not mutate domain
state or replace telemetry. The direct maintenance composition opens its own PostgreSQL connection and uses the
same owning Application Module implementations.
