# Research: Headless agent API and in-process maintenance boundary

Date: 2026-08-24
Status: Research report; recommendation for future implementation
Scope: Bob's TypeScript repository, primary standards, and first-party documentation only

## Recommendation

Use one normal, versioned Bob resource API for the UI and approved automation agents. Add machine authentication at
the authentication boundary. Do not duplicate the same resource operations under an `/agent` route family.

The request handler should resolve one trusted `RequestPrincipal` from either a Better Auth owner session or a
machine access token. The handler then applies the same resource policy and calls the same Application Module
Interface. The caller must not provide an Owner ID in a query parameter or header. Bob derives Owner or Bob Instance
scope from the trusted principal and durable authorization data.

Use OAuth 2.0 client credentials with an OIDC-compatible authorization server for long-lived agent integrations.
Require a Bob audience and narrow scopes. For a short-term private deployment, a database-backed API-key adapter is
acceptable. It must provide client identity, fixed scope, expiry, revocation, and audit data. A single static key
projected from OpenBao can be a bootstrap path, but it is not the final multi-agent credential model.

Keep maintenance as TypeScript command functions that compose the Database and Application Module Interfaces directly.
Run them in a short-lived job or pod from the Bob Core project image. A remote control plane may create and observe
the job through its provider API. It must not run the migration or data read by calling Bob's HTTP API.

This gives Bob three clear boundaries:

```text
browser or external agent
  -> one Bob resource API
  -> principal authentication and resource authorization
  -> Application Module Interface
  -> PostgreSQL, queue, or external Adapter

operator or control plane
  -> maintenance job or pod
  -> TypeScript command registry
  -> Application Module and Database Interfaces directly
```

## Questions and terms

“Agent” can mean two different callers in Bob:

1. The internal Agent Worker, which is a trusted Runtime role. Its current `/internal` routes are service-to-service
   protocols and should remain separate.
2. An external automation client, such as an operator helper, coding agent, or future Bob integration. This is the
   headless API client discussed here.

The second caller should use Bob's resource API. It should not receive a special copy of every UI operation. The first
caller should keep its internal protocol because it performs Runtime coordination that is not a user resource.

Bob already defines the relevant domain boundary. Its context describes Core Runtime as the API and UI owner, places
business rules and storage behind Application Module Interfaces, and keeps Owner scope in trusted identity and durable
records. See [Bob context](../../CONTEXT.md), especially the system map, domain language, and system invariants.

## Finding 1: use the normal domain API with machine authentication

### What the standards support

OAuth separates the client, resource owner, authorization server, and resource server. An access token represents a
limited authorization with a scope and duration. The resource server validates the token and serves the protected
resource. That model supports one resource API with different authentication methods. The resource handler does not
need a separate resource representation for each client type. See [RFC 6749, the OAuth 2.0 Authorization Framework](https://www.rfc-editor.org/rfc/rfc6749.html), including the access-token and client-credentials sections.

The client-credentials grant is intended for a confidential client acting on its own behalf or using access that was
previously arranged with the authorization server. It is a good fit for an approved automation agent that calls Bob
without a browser session. See [RFC 6749 Section 4.4](https://www.rfc-editor.org/rfc/rfc6749.html#section-4.4).

Bearer tokens are usable by whoever possesses them. They therefore need protection in storage and transport. Bob
should accept them only over its private HTTPS ingress and should not put them in logs, URLs, query parameters, or
error details. See [RFC 6750, Bearer Token Usage](https://www.rfc-editor.org/info/rfc6750/).

The current OAuth security best practice is stronger than a bare static bearer key. It recommends access-token
privilege restriction, audience restriction, and sender-constrained tokens where the deployment can support them. A
Bob token should therefore name Bob as its intended resource, carry narrow operation scopes, and have a short lifetime.
DPoP or mutual TLS can be added later for clients that need replay resistance. See [RFC 9700, OAuth 2.0 Security BCP](https://www.rfc-editor.org/rfc/rfc9700.html#section-4.10) and [RFC 9449, DPoP](https://www.rfc-editor.org/rfc/rfc9449.html).

OpenAPI is useful for the shared contract. It defines a language-neutral description that lets machines understand and
call one HTTP API, and it defines security scheme objects for API keys, bearer JWTs, OAuth2, and mutual TLS. Bob should
publish one description for its resource API, with the supported browser and machine security requirements on the
same operations. See the [OpenAPI Specification](https://spec.openapis.org/oas/v3.1.1.html#introduction) and its [security scheme](https://spec.openapis.org/oas/v3.1.1.html#security-scheme-object) section.

### Why duplicate agent routes are the weaker default

The prior implementation contained both paths that illustrated the difference:

- The Core HTTP entrypoint authenticates normal `/api/` requests with a Better Auth owner session. The message route
  can also resolve a machine credential.
- The same entrypoint contained separate `/v1/agent/activity/*` and `/v1/agent/messages` routes that called the same
  `ProductionDataInspector` and `ConversationStore` operations.

See the [Core HTTP entrypoint](../../apps/core/src/entrypoints/http.ts), [owner authentication service](../../packages/application/policy/service/src/auth/service.ts), and [headless authorization helper](../../packages/application/policy/service/src/headless.ts).

The separate route family creates a second public contract. It can drift in any of these areas:

- response shape and pagination;
- validation and time-window limits;
- owner and Bob Instance authorization;
- mutation idempotency;
- error status and error body;
- telemetry, audit, and rate limits;
- new fields added to the UI API;
- redaction of private message and provider data.

Duplicating the route also encourages a second policy implementation. The fact that both routes currently call the same
service is good, but it does not remove the long-term contract and authorization drift risk.

The normal API does not mean that every machine client gets every operation. It means that the operation has one domain
contract. The authorization layer can grant a machine principal only the operations allowed by its scopes and fixed
Owner or Bob Instance scope. A read-only agent can call message reads. It cannot call settings mutations or external
actions unless those operations are explicitly granted.

### The recommended request boundary

Bob should make the following concepts explicit at the policy boundary:

```text
RequestPrincipal
  - owner session: ownerId
  - machine token: clientId, ownerId or instanceId, scopes, audience, expiry
  - internal Runtime caller: service role and deployment identity
```

The HTTP adapter resolves the principal. The owning Application Module authorizes the operation against that
principal. The Application Module then receives a typed Owner or Instance scope. It does not receive a cookie, bearer
token, or HTTP request.

For example, both the UI and an approved agent may call the same message resource:

```text
GET /api/production-data/messages?from=...&to=...&limit=...
```

The UI authenticates with its Better Auth session. The agent authenticates with an access token. The service call is
the same bounded `ConversationStore.listMessages(ownerId, query)` operation. Neither caller supplies `ownerId` in the
request. The authorization result supplies it.

Bob should use [RFC 9457 Problem Details for HTTP APIs](https://www.rfc-editor.org/rfc/rfc9457.html) for stable,
machine-readable errors. This matters because non-human API consumers cannot depend on browser-oriented error pages.
Normal HTTP method semantics still apply. In particular, `GET` remains a safe, read-only method by contract; it must
not become a hidden mutation endpoint. See [RFC 9110 Section 9.2.1](https://www.rfc-editor.org/rfc/rfc9110.html#section-9.2.1).

### When a dedicated route is justified

A dedicated route is justified when the operation is not the same domain resource operation. Examples include:

- internal Agent Worker lease, checkpoint, or result protocols;
- a maintenance-job resource that submits a job and returns an execution ID;
- an asynchronous stream or batch export with a materially different lifecycle;
- a provider callback whose wire format is owned by the provider;
- a deliberately reduced operational projection that is not an Owner API resource.

Even in these cases, the route should call a named Application Module or Runtime Interface. It should not duplicate
database queries or message decryption. A route is a transport boundary, not a second domain boundary.

The current operator-only `/internal/production-data/*` routes are a good example of a separate operational projection.
They use a dedicated caller secret and return bounded metadata. They should remain distinct from the Owner message API.

## Finding 2: maintenance should call Interfaces directly

### What Bob already does

Bob's maintenance runtime is already close to the desired design:

- [tools/maintenance/runtime.ts](../../tools/maintenance/runtime.ts) opens the shared PostgreSQL Database Module;
- it creates the existing `ProductionDataInspector` Adapter;
- it lazily composes `ConversationStore` with the same data-protection and Owner Data Key services;
- it exposes a migration function from the Database Module;
- [read-latest-messages.ts](../../tools/maintenance/read-latest-messages.ts) and [read-all-messages.ts](../../tools/maintenance/read-all-messages.ts) call `ConversationStore.listMessages` directly;
- [tools/cli.tsx](../../tools/cli.tsx) statically registers TypeScript commands and uses Ink for presentation.

The current maintenance implementation follows the same boundary. [tools/maintenance/runtime.ts](../../tools/maintenance/runtime.ts)
composes the Database and Application Module Interfaces directly. [tools/maintenance/remote.ts](../../tools/maintenance/remote.ts)
places agent requests in a short-lived job or pod in the target Runtime Cluster and keeps command execution inside
the Core project image.

### Direct Interface calls versus HTTP

| Concern            | Direct Application Module Interface                | HTTP route to Core                                   |
| ------------------ | -------------------------------------------------- | ---------------------------------------------------- |
| Domain contract    | One typed TypeScript Interface                     | A second JSON and HTTP contract                      |
| Runtime dependency | Database and selected Adapters                     | Running Core, network, route, and auth               |
| Migration timing   | Can run before Core starts                         | Needs a compatible running Core                      |
| Policy location    | Command guard plus owning Module                   | Route guard plus owning Module                       |
| Serialization      | None inside the process                            | JSON parsing, response mapping, and transport errors |
| Testing            | Inject a fake Interface or Database Adapter        | Start or mock a server and wire protocol             |
| Failure model      | Process error and job result                       | Network, timeout, retry, auth, and process errors    |
| Security           | Job identity and least-privilege secret projection | Network-reachable privileged endpoint                |
| Best use           | Execute one reviewed maintenance command           | Submit, inspect, or cancel a job remotely            |

The direct path is the better execution boundary. It uses the same queries, encryption handling, migration program,
and domain rules as the Runtime. It also lets a migration run when the application process is intentionally stopped or
when the new image must prepare the database before the new replica starts.

HTTP remains useful one level above the command. A Control Plane or operator tool can request a maintenance job from a
deployment provider, then read the job status and logs. That remote API should carry a typed `MaintenanceJobSpec` with
the target cluster, release, image digest, command name, execution ID, and safety metadata. The job itself should not
call Core over HTTP to perform the work.

Kubernetes expresses this operational shape directly. A Job represents a one-off task that runs to completion, creates
Pods, and retries failed Pods within its configured policy. A Job is recommended over a bare Pod when the task needs
completion tracking and replacement after a node or Pod failure. See the [Kubernetes Job documentation](https://kubernetes.io/docs/concepts/workloads/controllers/job/).

The same rule applies to Coolify or an Argo Adapter. The provider creates the short-lived execution object. The Bob
process inside it calls TypeScript Interfaces. The provider owns scheduling, retry, timeout, and status. The command
owns validation, scope, dry-run rules, and its domain operation.

### Future PIM commands

PIM should follow the same split:

1. Put PIM business rules and storage behind a PIM Application Module Interface.
2. Add a reviewed `tools/maintenance/pim-*` TypeScript command that calls that Interface directly.
3. Run it in the same image and cluster job boundary as other maintenance commands.
4. Add a normal resource API only when PIM is also a user or agent data-plane capability.
5. Let the API and maintenance command share the PIM Interface. Do not let either path duplicate PIM SQL or policy.

This keeps the CLI as a set of typed functions. Ink remains the terminal presentation layer. It does not become a place
for database, OpenBao, or production authorization logic.

## Credential and OpenBao boundary

Bob needs to distinguish three credential classes:

| Credential class                         | Owner                                  | Recommended storage and use                                                                                                  |
| ---------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Bob API client credential                | Bob's auth or policy module            | Durable client metadata, scope, expiry, revocation, and audit. Use OAuth access tokens or a database-backed API-key adapter. |
| Provider credential used by Bob          | The owning Agent or Connection Adapter | OpenBao secret, projected only to the responsible Runtime consumer.                                                          |
| Workload credential used to read OpenBao | Deployment or job identity             | Short-lived JWT/OIDC or another reviewed workload auth method. It grants only the required OpenBao paths.                    |

OpenBao's KV engine is a generic secret store. KV v2 supports versions and ACL-separated data operations. The OpenBao
JWT/OIDC auth method verifies a JWT or uses an OIDC provider, then evaluates claims and policies for the OpenBao
identity. These features make OpenBao appropriate for Bob's provider secrets and for secret projection into a Runtime
or maintenance job. See the [OpenBao KV documentation](https://openbao.org/docs/secrets/kv/kv-v2/) and the [OpenBao JWT/OIDC documentation](https://openbao.org/docs/auth/jwt/).

OpenBao is not Bob's per-request resource authorization system. That is an architectural conclusion from the separation
of responsibilities: OpenBao authenticates a workload to OpenBao and stores secrets; Bob still needs to authorize a
request against an Owner or Bob Instance. Bob should not call OpenBao for every API request, and it should not expose
OpenBao credentials to an external agent.

The current repository follows the useful part of this model. [tools/.env.schema](../../tools/.env.schema) resolves an
allowlist of maintenance values from the existing Runtime Cluster secret. It does not copy secret values into the
repository. [Bob context](../../CONTEXT.md) states that OpenBao is authoritative for production configuration and
credentials, while Varlock validates and resolves the runnable environment.

For Bob API client keys, the current single `BOB_HEADLESS_API_KEY` projection is acceptable only as a private bootstrap
credential. It has a deployment-wide scope, depends on process configuration, and needs a restart or redeploy to
rotate. It does not provide independent client expiry or revocation.

If Bob continues with API keys before an OAuth authorization server is available, use a lifecycle-aware API-key system.
Better Auth's official API-key plugin documents creation, verification, expiration, metadata, permissions, rate limits,
and user- or organization-owned keys. See the [Better Auth API Key plugin](https://better-auth.com/docs/plugins/api-key).
For Bob, the ownership mapping should be an explicit Owner or Bob Instance scope. Do not accept an Owner ID supplied by
the caller. Store only the verifier and lifecycle metadata in the database or auth module where practical. Keep any
one-time issuance material in the client's secret provider, such as OpenBao, and never log it.

## Concrete Bob boundary

### Data-plane API

- Keep one resource contract for UI and external agents.
- Add a machine principal resolver beside the existing Better Auth session resolver.
- Prefer OAuth 2.0 client credentials and short-lived, audience-restricted tokens for external automation.
- Use narrow scopes such as `conversation:read`, `activity:read`, or a future explicit mutation scope.
- Bind every machine credential to one Owner or Bob Instance. A cluster-wide credential must not read message content
  across Owners.
- Derive scope from the token or a durable credential record. Never accept scope in a request parameter or header.
- Keep `/internal` service protocols and metadata-only operator routes separate when their semantics differ from normal
  Owner resources.
- Publish one OpenAPI description and one error model for the resource API.
- Keep message reads bounded by time window and row limits. Keep provider handles, ciphertext, and private Agent payloads
  outside the public representation.

### Maintenance plane

- Keep commands in `tools/` as statically registered TypeScript functions.
- Inject the small set of Application Module and Database Interfaces needed by each command.
- Keep migrations, message reads, and future PIM maintenance off the HTTP surface.
- Run production commands as one-shot jobs or Pods in the target Runtime Cluster.
- Use the exact Bob Core project image and immutable digest that the job runner records.
- Use a separate maintenance Varlock schema and least-privilege OpenBao policy.
- Keep command approval, dry-run, row limits, execution identity, and audit fields in the command/job boundary.
- Let the provider or Control Plane submit and observe jobs. Do not turn the command registry into an HTTP server.

### Migration path from the current worktree

The current worktree already has the desired direct maintenance composition. The API side now converges in this order:

1. Keep the existing bounded route behavior while the principal model is introduced.
2. Make normal resource handlers accept a trusted machine principal in addition to an Owner session.
3. Move the owner and scope decision into shared policy code. Keep it out of individual agent route branches.
4. Remove duplicate `/v1/agent/*` resource routes. The current implementation uses the normal resource API.
5. Replace the deployment-wide static key with lifecycle-aware API clients or OAuth/OIDC tokens.
6. Keep dedicated routes only for internal Runtime protocols, job submission/status, and genuinely different projections.

The implementation removes the duplicate resource routes and keeps the bounded machine read on the canonical
`/api/production-data/messages` route. It also verifies that maintenance commands call TypeScript Interfaces directly.

## Sources

### Bob local source

- [Bob context](../../CONTEXT.md)
- [Core HTTP entrypoint](../../apps/core/src/entrypoints/http.ts)
- [Better Auth composition](../../packages/application/policy/service/src/auth/service.ts)
- [Headless authorization helper](../../packages/application/policy/service/src/headless.ts)
- [ConversationStore Interface](../../packages/application/conversations/types/src/store.ts)
- [ConversationStore implementation](../../packages/application/conversations/service/src/store.ts)
- [Maintenance runtime composition](../../tools/maintenance/runtime.ts)
- [Maintenance message commands](../../tools/maintenance/read-latest-messages.ts) and [read-all-messages.ts](../../tools/maintenance/read-all-messages.ts)
- [Ink command registry](../../tools/cli.tsx)
- [Maintenance environment schema](../../tools/.env.schema)
- [Cluster-scoped maintenance requests](../../tools/maintenance/remote.ts)
- [Runtime deployment contract](../../deployment/README.md)

### Standards and first-party documentation

- [RFC 6749: The OAuth 2.0 Authorization Framework](https://www.rfc-editor.org/rfc/rfc6749.html)
- [RFC 6750: OAuth 2.0 Bearer Token Usage](https://www.rfc-editor.org/info/rfc6750/)
- [RFC 8707: Resource Indicators for OAuth 2.0](https://www.rfc-editor.org/rfc/rfc8707.html)
- [RFC 9110: HTTP Semantics](https://www.rfc-editor.org/rfc/rfc9110.html)
- [RFC 9449: OAuth 2.0 DPoP](https://www.rfc-editor.org/rfc/rfc9449.html)
- [RFC 9457: Problem Details for HTTP APIs](https://www.rfc-editor.org/rfc/rfc9457.html)
- [RFC 9700: Best Current Practice for OAuth 2.0 Security](https://www.rfc-editor.org/rfc/rfc9700.html)
- [OpenAPI Specification 3.1.1](https://spec.openapis.org/oas/v3.1.1.html)
- [Better Auth API Key plugin](https://better-auth.com/docs/plugins/api-key)
- [OpenBao KV v2](https://openbao.org/docs/secrets/kv/kv-v2/)
- [OpenBao JWT/OIDC auth method](https://openbao.org/docs/auth/jwt/)
- [Kubernetes Jobs](https://kubernetes.io/docs/concepts/workloads/controllers/job/)
