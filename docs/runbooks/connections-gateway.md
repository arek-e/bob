# Connections Gateway runbook

The Connections Gateway gives managed Bob Instances scoped access to one Nango environment.

It is an application data-plane Module. Do not deploy it inside the Bob Control Plane.

## Required resources

Deploy these shared resources once per environment or region:

- One Connections Gateway Worker
- One D1 Instance identity registry
- One Cloudflare Access application
- One Nango deployment
- Nango PostgreSQL, Redis, and required Nango stores

Apply `apps/connections-gateway/migrations` to the gateway D1 database.

Configure the gateway with its Access audience, Nango origin, Nango secret, and integration IDs.

## Register a Bob Instance

Create one Cloudflare Access service token for each Bob Instance.

Insert its `common_name` and Bob Instance ID into `connection_gateway_callers`.

Store the client ID and secret at the Instance OpenBao path.

Set the Instance `CONNECTIONS_GATEWAY_URL` to the shared gateway origin.

Never reuse one service token across Bob Instances.

Set `revoked_at` before removing a compromised caller identity from Access.

## Nango exposure

Keep Nango administration and secret-authorized routes private.

Expose only the callback and Connect UI routes required by owner authorization.

The Connections Gateway is the only Bob Module that receives the Nango environment secret.

## Migrate an existing Instance

Deploy and verify the gateway before removing Nango from the Bob Instance.

Existing Nango connections use an unscoped Owner ID.

Move them to the versioned Instance-scoped owner reference before cutover.

Require owner reconnection when a connection cannot be moved safely.

Verify connection listing and one new Connect session after cutover.

Then remove the Nango environment secret from the core Worker.

Remove the per-Instance Nango and Redis resources only after backup verification.
