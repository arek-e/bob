# OSS HTTP API structure comparison

Date: 2026-08-24
Status: Research report; recommendation for Bob Runtime
Scope: Official repositories, API references, and architecture documentation only.

## Recommendation

Bob should use a feature-oriented API structure with four clear boundaries:

1. A thin HTTP transport layer for routing, decoding, authentication, and response mapping.
2. Application Modules for domain rules, queries, workflows, and mutations.
3. Database adapters behind existing `Store` interfaces.
4. Separate internal service protocols under `/internal`.

Use one resource API for the browser and approved automation agents. Do not create an `/agent` copy of each route. Resolve a normalized `RequestPrincipal` at the HTTP boundary, then apply the same resource policy and Application Module operation.

Use `/api/v1` as the first stable Core Runtime API when the private `/api` surface becomes an external contract. Keep the Control Plane API on `/v1`. Do not add `/v2` before a real breaking change requires it.

The strongest choices from this comparison are:

- Appwrite for feature-first route layout and URL-mirrored action files.
- Mattermost for a clear API, application, and store separation.
- Supabase for explicit human, public-client, and server-client authentication modes.
- GitLab for API versioning, compatibility rules, and generated OpenAPI governance.
- Outline as a useful warning: RPC routes and very large route files make boundaries harder to enforce.

## Comparison

### GitLab

GitLab keeps REST API endpoints in [`lib/api`](https://gitlab.com/gitlab-org/gitlab/-/tree/master/lib/api), while state-changing service objects live in [`app/services`](https://gitlab.com/gitlab-org/gitlab/-/tree/master/app/services). GitLab’s design guide describes API endpoints as controller-level code and service classes as operations that coordinate changes between models. This gives the transport and domain-operation layers different homes. See the [abstraction guidance](https://docs.gitlab.com/development/reusing_abstractions/).

The REST API uses `/api/v4`. GitLab documents the version as an independent semantic API version. Breaking changes require a major version change, while additive changes stay in the current version. See [REST versioning](https://docs.gitlab.com/api/rest/) and the [API style guide](https://docs.gitlab.com/development/api_styleguide/).

GitLab supports session cookies for its own web frontend, OAuth 2.0, personal/project/group access tokens, and scoped CI job tokens. The same REST API serves these callers. See [REST authentication](https://docs.gitlab.com/api/rest/authentication/).

The API code is the OpenAPI source of truth. GitLab generates the OpenAPI document from that code. Request specs are grouped under [`spec/requests/api`](https://gitlab.com/gitlab-org/gitlab/-/tree/master/spec/requests/api). See [OpenAPI generation](https://docs.gitlab.com/api/openapi/).

### Mattermost

Mattermost separates the server into [`api4`](https://github.com/mattermost/mattermost/tree/master/server/channels/api4), [`app`](https://github.com/mattermost/mattermost/tree/master/server/channels/app), and [`store`](https://github.com/mattermost/mattermost/tree/master/server/channels/store) packages. API handlers register routes and permissions. Application code owns workflows and policy. Store packages own persistence operations. The broader [`server/channels`](https://github.com/mattermost/mattermost/tree/master/server/channels) package also separates jobs, web handlers, and utilities.

The REST contract uses `/api/v4`. Its source-controlled OpenAPI material is organized by resource under [`api/v4/source`](https://github.com/mattermost/mattermost/tree/master/api/v4/source), with an introduction that documents the URL and conventions. See [Mattermost API conventions](https://github.com/mattermost/mattermost/blob/master/api/v4/source/introduction.yaml).

Human sessions, personal access tokens, bot accounts, and OAuth 2.0 applications authenticate against the same API. Personal access tokens are intended for integrations, and OAuth tokens act on behalf of an authorized user. See [personal access tokens](https://developers.mattermost.com/integrate/reference/personal-access-token/), [bot accounts](https://developers.mattermost.com/integrate/reference/bot-accounts/), and [OAuth 2.0](https://developers.mattermost.com/integrate/apps/authentication/oauth2/).

Go tests sit beside package source files, while API reference material sits in the versioned `api` tree. This makes local package behavior easy to find, but keeps the public contract visible separately.

### Outline

Outline’s architecture document gives a clear backend map: [`routes/api`](https://github.com/outline/outline/tree/main/server/routes/api), [`routes/auth`](https://github.com/outline/outline/tree/main/server/routes/auth), [`commands`](https://github.com/outline/outline/tree/main/server/commands), [`models`](https://github.com/outline/outline/tree/main/server/models), [`policies`](https://github.com/outline/outline/tree/main/server/policies), [`presenters`](https://github.com/outline/outline/tree/main/server/presenters), queues, and a test directory. It explicitly states that tests are colocated. See [Outline’s architecture map](https://github.com/outline/outline/blob/main/docs/ARCHITECTURE.md).

The API is RPC-style: every operation is a `POST` to `/api/:method`, such as `documents.info`. The main application uses this API too. See the [official API documentation](https://www.getoutline.com/developers) and an example [document route](https://github.com/outline/outline/blob/main/server/routes/api/documents/documents.ts).

Outline supports bearer API keys and OAuth 2.0 on the same API. Its documentation warns that API keys provide broad access, so key scope needs careful operational control. The OpenAPI document lives in a separate first-party [`outline/openapi`](https://github.com/outline/openapi) repository.

Outline is a good example of keeping policies, presenters, commands, and models visible. It is a weaker model for Bob’s public API because RPC method paths make resource discovery, HTTP semantics, and version evolution less explicit. The large `documents.ts` route file also shows why Bob should keep transport handlers small.

### Appwrite

Appwrite uses feature modules under [`src/Appwrite/Platform/Modules`](https://github.com/appwrite/appwrite/tree/main/src/Appwrite/Platform/Modules). Each module contains HTTP registration, endpoint actions, workers, and tasks. HTTP directories mirror URL nesting. Action files use `Create.php`, `Get.php`, `Update.php`, `Delete.php`, and `XList.php`. Non-CRUD actions become resource or property updates instead of custom RPC verbs. These rules are documented in Appwrite’s first-party [`AGENTS.md`](https://github.com/appwrite/appwrite/blob/main/AGENTS.md).

The REST API uses `/v1`. The `X-Appwrite-Response-Format` header provides a compatibility format version without creating a new route family. See the [REST reference](https://appwrite.io/docs/apis/rest).

Appwrite distinguishes account sessions, server API keys, and JWTs. Its REST documentation says server API keys are for backend integrations and must not be used in client applications. See [Appwrite authentication](https://appwrite.io/docs/advanced/security/authentication) and the [server/client quick start](https://appwrite.io/docs/references/quick-start).

Tests follow the feature boundary: E2E tests under `tests/e2e/Services/{Service}` mirror the API service, and unit tests mirror source paths. This is the clearest test-colocation rule in the comparison.

### Supabase

Supabase is a composed platform rather than one large application API. Its gateway exposes separate service boundaries: REST at `/rest/v1`, Auth at `/auth/v1`, Storage at `/storage/v1`, and Realtime at `/realtime/v1`. The official self-hosting architecture places Kong in front of GoTrue, PostgREST, Realtime, Storage, and other services. See the [self-hosting architecture](https://github.com/supabase/supabase/blob/master/apps/docs/content/guides/self-hosting/docker.mdx).

PostgREST generates the REST surface from PostgreSQL tables, views, functions, and schemas. It uses database roles and policies for authorization, and its documentation describes schema-based API versioning. See the [PostgREST architecture and versioning notes](https://github.com/PostgREST/postgrest#readme).

Supabase Auth uses a separate OpenAPI contract at [`supabase/auth/openapi.yaml`](https://github.com/supabase/auth/blob/master/openapi.yaml). The official server package makes the auth distinction explicit: `user`, `publishable`, `secret`, and `none` modes produce a context that records the matched mode and provides either an RLS-scoped or admin client. See [auth modes](https://github.com/supabase/server/blob/main/docs/auth-modes.md) and the [server context](https://github.com/supabase/server/blob/main/README.md).

Supabase is the best reference for Bob’s principal model and auth separation. It is not the best source-tree template for Bob because its API is split across independent services and generated database surfaces.

## Bob target layout

Bob already has Application Module `types` and `service` packages, `Store` interfaces, static route modules, and a separate database package. The refactor should deepen that direction instead of adding a generic controller or repository framework.

```text
apps/core/src/entrypoints/http.ts        # bootstrap and shared transport only
apps/core/src/http/
  router.ts                              # route assembly and method/path matching
  auth/
    principal.ts                         # human, machine, and internal principals
    session.ts                            # Better Auth session adapter
    machine-credential.ts                # bearer/OIDC credential adapter
  presenters/
  errors.ts

packages/application/<capability>/
  types/src/                             # contracts, schemas, Store ports
  service/src/
    rules.ts                             # domain rules
    queries.ts                            # read operations
    commands.ts                           # mutations and workflows
    owner-routes.ts                       # thin capability route adapter
  service/test/                           # module and route-adapter tests

packages/db/service/src/schema/           # Drizzle schemas and migrations
apps/core/test/http/                      # end-to-end HTTP contract tests
docs/api/openapi.yaml                     # checked-in public API description
```

Use these rules:

- Route adapters decode input, resolve the principal, call one Application Module operation, and map errors.
- Application services own policy, privacy, idempotency, and workflow rules.
- Existing `Store` interfaces are Bob’s persistence ports. Keep database implementations behind them. Do not add a repository layer only to match another project’s name.
- Keep owner routes and internal service routes in separate assemblies. Internal routes must not become machine-client shortcuts.
- Generate or validate the OpenAPI document from the same schemas used by the route contract. Keep the document in source control.
- Test every resource with human, machine, unauthorized, wrong-owner, and malformed-input cases.
- Keep migrations and maintenance commands outside the HTTP path. They should call Application and Database Interfaces directly.

## Final choice

Adopt Appwrite’s feature-first organization, Mattermost’s service/store boundary, Supabase’s explicit auth-mode principal, and GitLab’s API governance. Use standard REST resources for Bob’s Core API, with `/api/v1` as the first stable public version and `/internal` for private service protocols. Keep the current static module registration and Effect service interfaces. Avoid Outline-style RPC routes and avoid a second agent-specific API.

This report changes no application code.
