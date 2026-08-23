# ADR 0004: Bounded production data inspection

Status: Accepted
Date: 2026-08-23

## Context

Operators need to understand message volume, Agent Run state, Tool activity, and delivery failures in the
production Runtime. Coolify manages the Runtime Cluster, but it is not the application data authority and its
resource views do not show PostgreSQL rows.

The application stores message and Agent Run payloads as private data. A general SQL endpoint or an operator
endpoint that decrypts all Owner data would bypass the existing privacy and ownership boundaries.

## Decision

Add a production data inspector to the Operations Application Module. It exposes two internal, read-only
operations:

- a bounded time-window summary of counts and pseudonymous owner interaction aggregates;
- bounded workflow metadata for one correlation ID.

Protect both operations with a dedicated `PRODUCTION_DATA_INSPECTOR_SECRET`. Keep this secret separate from
ingress, egress, and Agent caller secrets. Select only status, timing, model, Tool name, and opaque record
references. Do not select message ciphertext, private snapshots, Tool arguments or results, provider handles,
phone numbers, idempotency keys, or credentials.

Expose owner message content only through the existing Better Auth owner-session boundary. Limit the query to a
bounded time window and result count. The operator secret cannot authorize this content route.

Keep PostgreSQL authoritative. Do not add arbitrary SQL, runtime discovery, a Coolify database tunnel, or an
Argo migration. The Control Plane and Coolify continue to own deployment, health, release, and backup actions.

## Consequences

Operators can inspect production interaction and failure shape without receiving private message content.
Owners can read their own recent messages through the existing authenticated API.

The Runtime release needs a `PRODUCTION_DATA_INSPECTOR_SECRET` projection for the Core consumer. OpenBao must
provide the value before the release becomes ready. A deployment that omits the projection fails Core
configuration validation instead of silently exposing an unauthenticated route.

The inspector adds bounded PostgreSQL reads to Core. These reads are metadata-only and do not mutate domain
state or replace telemetry.
