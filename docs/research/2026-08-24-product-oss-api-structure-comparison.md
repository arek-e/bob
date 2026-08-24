# Product-focused OSS API and file-structure comparison

Date: 2026-08-24
Status: Research report; recommendation for Bob Runtime
Scope: Chatwoot, Twenty, Plane, Outline, and Cal.diy. Sources are official repositories or official documentation.

## Recommendation

Use Twenty as the closest structural reference for Bob. It is a TypeScript product with feature modules, a server application, database code, queues, and a React client. Keep Bob's existing application-module split, then make the HTTP layer thinner around those modules.

Combine the references as follows:

- Feature modules: Twenty's server modules are the best match for Bob's TypeScript application modules.
- HTTP contract: Chatwoot and Plane show the value of versioned, resource-oriented APIs with explicit API documentation.
- Use cases and policy: Outline makes commands, policies, presenters, models, queues, and routes visible as separate concerns. Use the separation, not its RPC API shape.
- Extensions: Cal.diy shows how feature code and integrations can live in self-contained packages.
- Agent access: Keep one resource API for the UI and approved agents. Change the principal and scopes, not the resource routes.

This supports Bob's current direction. It does not justify a new framework, a repository layer, or a second agent API.

## Bob baseline

Bob already has the important boundaries:

- packages/application/<module>/types owns module interfaces and validation.
- packages/application/<module>/service owns rules, queries, workflows, mutations, and route adapters.
- packages/db/types owns database ports; packages/db/service owns Drizzle schemas, migrations, and implementations.
- apps/core owns runtime composition and the HTTP entrypoint.
- Maintenance runs application and database interfaces directly. It does not need to call Bob's HTTP routes.

The main gap is transport concentration in apps/core/src/entrypoints/http.ts. The product projects below support extracting shared routing, authentication, errors, and presenters while keeping feature ownership in application modules.

## Project comparison

### Chatwoot

Chatwoot follows a conventional Rails product structure. API controllers are grouped by version and product area under [app/controllers/api/v1](https://github.com/chatwoot/chatwoot/tree/develop/app/controllers/api/v1). Domain operations are grouped under feature-oriented service directories such as [conversations](https://github.com/chatwoot/chatwoot/tree/develop/app/services/conversations) and [contacts](https://github.com/chatwoot/chatwoot/tree/develop/app/services/contacts). Its [backend guidelines](https://www.chatwoot.com/hc/handbook/articles/1743728412-backend-guidelines) recommend RESTful controllers, service objects, request/system tests, and documented APIs.

Its API contract separates application, client, and platform APIs while using /api/v1 resource paths. The checked-in [OpenAPI path index](https://github.com/chatwoot/chatwoot/blob/develop/swagger/paths/index.yml) makes that split visible. Application APIs use a user access token; client APIs use inbox and contact identifiers; platform APIs serve installation-level operations. See the [API introduction](https://developers.chatwoot.com/api-reference/introduction).

Persistence follows Rails model and migration conventions. The repository keeps models in [app/models](https://github.com/chatwoot/chatwoot/tree/develop/app/models) and migrations under [db/migrate](https://github.com/chatwoot/chatwoot/tree/develop/db/migrate). Request tests are grouped under [spec/requests/api](https://github.com/chatwoot/chatwoot/tree/develop/spec/requests/api).

Use for Bob: copy the feature grouping, versioned resource contract, and request-test discipline. Bob's Application Modules are a better home for domain work than HTTP controllers.

### Twenty

Twenty is the strongest match for Bob's language and architecture. Its server separates application concerns into [server modules](https://github.com/twentyhq/twenty/tree/main/packages/twenty-server/src/modules), with product areas such as calendar, messaging, workflow, timeline, tasks, and dashboards. The [server root](https://github.com/twentyhq/twenty/tree/main/packages/twenty-server/src) also exposes database, engine, and queue-worker boundaries.

Twenty's product API has two deliberate surfaces: a Core API for records and a Metadata API for schema changes. Both REST and GraphQL are generated from the workspace schema. API keys are bearer credentials and can be assigned to a role; OAuth is used for external applications acting for users. See the official [API documentation](https://docs.twenty.com/developers/extend/api).

Persistence is an explicit server concern. The server package includes database code and production migration commands, and its dependencies include PostgreSQL and TypeORM. See the [server package](https://github.com/twentyhq/twenty/blob/main/packages/twenty-server/package.json). The project documents backend unit tests and database-reset integration tests with Nx and Jest in its [development guide](https://github.com/twentyhq/twenty/blob/main/CLAUDE.md).

Use for Bob: treat this as the primary layout reference. Bob's application modules are already the right kind of seam. Keep persistence behind packages/db and keep workers or maintenance entrypoints outside HTTP.

### Plane

Plane is a product-focused project-management application with work items, cycles, modules, views, pages, and webhooks. Its official [repository](https://github.com/makeplane/plane) is a monorepo with apps and packages. Its README identifies Python/Django, PostgreSQL, Redis, React, and TypeScript components. It is useful as a product-boundary reference, but less useful than Twenty for Bob's TypeScript file layout.

The [API reference](https://developers.plane.so/api-reference/introduction) defines predictable resource-oriented URLs under /api/v1, JSON request and response bodies, standard HTTP verbs and status codes, and API-key authentication. It also documents a real deprecation from /issues/ to /work-items/. Plane's [developer documentation](https://developers.plane.so/) covers REST resources, webhooks, OAuth applications, and MCP agents.

The self-hosting documentation describes configurable product authentication, while the API uses personal API keys in the X-API-Key header. See [authentication](https://developers.plane.so/self-hosting/govern/authentication). The repository includes a [test compose configuration](https://github.com/makeplane/plane/blob/master/docker-compose-test.yml), but its API documentation is the more useful reference for Bob.

Use for Bob: copy resource naming, explicit /api/v1 governance, deprecation policy, webhooks, and agent integration. Do not copy its Python/Django service layout into the TypeScript runtime.

### Outline

Outline's server tree makes product concerns easy to locate: feature folders live under [server/routes/api](https://github.com/outline/outline/tree/main/server/routes/api), while commands, models, policies, presenters, queues, storage, migrations, and tests have separate homes under [server](https://github.com/outline/outline/tree/main/server). The [document route](https://github.com/outline/outline/blob/main/server/routes/api/documents/documents.ts) shows a route adapter coordinating commands, models, and middleware.

The main application and programmatic clients use the same API. Outline uses POST /api/:method RPC-style calls, bearer API keys, OAuth 2.0, endpoint or namespace scopes, pagination, and standard HTTP status codes. These details are documented in the official [API reference](https://www.getoutline.com/developers).

Use for Bob: copy the visible separation of route adapters, commands, policies, presenters, persistence models, queues, and tests. Avoid the RPC method URL shape. Bob should use resource-oriented HTTP paths so browser and agent clients can discover and reuse the same contract.

### Cal.diy

Cal.diy is the current public open-source scheduling codebase from the Cal project. Its repository guidance documents a feature-oriented monorepo with packages/features, packages/prisma, packages/trpc, and packages/app-store. It also has a separate NestJS API application under [apps/api/v2](https://github.com/calcom/cal.diy/tree/main/apps/api/v2).

The API app has its own tests and transport boundary. Repository guidance warns that the API app imports shared feature code through an explicit platform-library boundary. The same guidance identifies PostgreSQL with Prisma, tRPC routers, NextAuth.js, Vitest unit tests, and Playwright end-to-end tests. See [Cal.diy's AGENTS.md](https://github.com/calcom/cal.diy/blob/main/AGENTS.md).

Cal.diy's app-store guidance packages each integration with local API, component, static, and entrypoint files. See [how to build an app](https://cal.com/help/apps-and-integrations/how-to-build-an-app). Its API reference documents API-key and OAuth/platform authentication, version headers, scopes, and standard errors in the repository's [authentication reference](https://github.com/calcom/cal.diy/blob/main/agents/skills/calcom-api/references/authentication.md).

Use for Bob: copy self-contained feature and integration packages. Do not create a separate API application for Bob unless a deployment boundary requires it. Bob's maintenance runtime should call shared Application Module interfaces directly.

## Decision for Bob

| Concern             | Bob choice                                                                        | Product reference           |
| ------------------- | --------------------------------------------------------------------------------- | --------------------------- |
| Feature ownership   | Keep packages/application/<module> as the source of truth                         | Twenty                      |
| Route ownership     | Thin module-owned adapters plus shared Core transport                             | Chatwoot, Outline           |
| Public contract     | Resource-oriented REST; introduce /api/v1 when the Core API becomes stable        | Chatwoot, Plane             |
| UI and agent access | One API, one normalized principal model, different credentials/scopes             | Chatwoot, Twenty            |
| Domain operations   | rules.ts, queries.ts, commands.ts; no business logic in handlers                  | Chatwoot, Outline           |
| Persistence         | Keep Store interfaces and Drizzle implementations behind packages/db              | Twenty, Cal.diy             |
| Tests               | Module tests plus HTTP contract tests for auth, ownership, validation, and errors | Chatwoot, Twenty, Cal.diy   |
| Extensions          | Add feature-local integration packages only at a real extension boundary          | Cal.diy                     |
| Maintenance         | Direct Application and Database Interfaces in jobs or pods                        | Bob's existing architecture |

The target shape is:

```text
apps/core/src/
  entrypoints/http.ts          # bootstrap only
  http/
    router.ts
    auth/
    presenters/
    errors.ts

packages/application/<capability>/
  types/src/
  service/src/
    rules.ts
    queries.ts
    commands.ts
    owner-routes.ts             # thin transport adapter
  service/test/

packages/db/
  types/
  service/

apps/core/test/http/
docs/api/openapi.yaml
```

This is an incremental extraction from the current Core HTTP entrypoint. It is not a version-two rewrite. Keep current private routes working, reserve /internal for service protocols, and add a stable /api/v1 surface only when its compatibility contract is ready.

## Conclusion

Product-focused OSS projects confirm that Bob should be feature-first, not controller-first. Twenty is the best structural model. Chatwoot and Plane provide the strongest API-governance lessons. Outline provides the clearest command/policy/presenter separation, with an RPC shape Bob should avoid. Cal.diy provides the best integration-package pattern.

No application code was changed for this report.
