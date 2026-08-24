# ADR 0008: Feature-owned Core HTTP route adapters

Status: Accepted
Date: 2026-08-24

## Context

The Core HTTP entrypoint had one large implementation for health, authentication, setup, owner resources, and
internal service protocols. The file mixed transport rules with application calls. A change in one product area
required reading unrelated routes.

Bob needs a product-shaped HTTP layout. The browser and approved automation clients must use the same owner resource
routes. Internal Runtime calls need a separate transport path. Maintenance commands already call Application and
Database Interfaces directly and must remain outside HTTP.

## Decision

Keep `apps/core/src/entrypoints/http.ts` as the hosting entrypoint. It owns only:

- top-level path classification;
- authentication and caller authorization;
- Runtime composition;
- shared request context; and
- final error mapping.

Place shared HTTP adapters under `apps/core/src/http`:

- `body.ts` owns bounded body reads and idempotency-key decoding;
- `response.ts` owns security headers and JSON responses;
- `authentication.ts` owns owner-session and machine-credential adapters;
- `setup.ts` owns setup and owner enrollment handlers; and
- `routes/owner` and `routes/internal` own feature route adapters.

Group owner routes by product area: production data, settings, alerts, memory, agent access, and installed Vertical
Modules. Group internal routes by Runtime area: operations, conversations, delivery, and Agent Runs.

Route adapters decode transport input, resolve the trusted principal, call an Application Module Interface, and map
the result. They do not implement domain policy or database queries. Application Modules remain authoritative for
privacy, ownership, idempotency, and mutation rules.

Keep one owner resource API for the browser and approved agents. A machine credential changes the principal and scope.
It does not create an agent-specific route family. Keep `/internal` for private service protocols.

Do not change the current route paths in this refactor. Introduce `/api/v1` only in a separate compatibility decision
when the Core API becomes a stable external contract.

## Consequences

The Core entrypoint is small. Product behavior has local ownership, and route tests can target one feature adapter.
Shared request limits, security headers, authentication, and error mapping have one implementation.

The route adapter layer remains an app-owned seam. It does not add a generic controller framework or a repository
layer. Existing static owner route Modules keep their current Interface and registration model.

The current HTTP contract stays compatible. Future API versioning can add a versioned route assembly without moving
Application Module Interfaces or maintenance commands.
