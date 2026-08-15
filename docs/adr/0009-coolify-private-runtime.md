# ADR 0009: Use Coolify for the self-hosted private runtime

- Status: Accepted for self-hosting
- Date: 2026-08-12
- Scope: Self-hosted Agent, backups, private ingress, and deployment operations
- Managed orchestration superseded by: ADR 0014
- Managed connection ownership superseded by: ADR 0013
- Managed Secret Projection amended by: ADR 0015

## Context

Bob needs a simple private Runtime that agents can inspect and recover safely.

The Runtime must not own Cloudflare infrastructure, application data, or production secrets.

Coolify supports reviewed Docker Compose deployments and a narrow operational Interface.

Managed Bob Instances use the portable deployment contract from ADR 0014.

## Decision

Use Coolify as the hosting Implementation for the self-hosted single-Owner Runtime.

Coolify is not the managed orchestration authority.

Keep Cloudflare as the public edge and application data plane.

Keep OpenBao as the production secret authority.

Keep Alchemy as the owner of declared Cloudflare resources.

### Runtime ownership

Coolify hosts these self-hosted resources:

- the Bob Agent application;
- the Runtime Cloudflare Tunnel connector;
- the Bob backup runner and schedule;
- the content-free host and container metrics collector.

Use `infra/coolify/compose.yaml` as the application stack source.

Do not publish container ports on the host.

The Tunnel connector is the only public application ingress.

Use immutable image digests for every production container.

The metrics collector can read host statistics, backup modification times, and Docker statistics.

Use read-only mounts where possible.

Do not send application logs, environment values, or backup contents through this pipeline.

### Secret delivery

Use a scoped OpenBao AppRole for the self-hosted Agent.

Mount the AppRole secret ID as a protected Docker secret file.

Never put the secret ID in a command argument, image, or committed file.

Give the Agent AppRole only the Pi credential policy.

OpenBao remains authoritative for every secret value.

Regular deployment agents cannot read or change secret values.

Managed Instances use the protected Secret Projection from ADR 0015 instead.

### Agent access

Run Coolify in a dedicated KVM guest.

Keep Docker and its network rules inside that guest.

Publish the Coolify dashboard only to the Tailnet.

Give regular agents a team-scoped token with read and deploy permissions.

Do not give regular agents sensitive-read, write, or root permissions.

Use the `deploy-bob-coolify` skill for deployment and rollback work.

The skill adds process rules. It does not add permissions.

### Backup ownership

Copy each encrypted D1 and R2 archive to the reviewed private backup target.

Use one bucket-scoped Object Read and Write token for the backup process.

Do not give the process R2 bucket administration permission.

Keep the age identity outside the Coolify host.

Keep a local encrypted copy for fast recovery.

Test both restore paths through the backup runbook.

## Verification

Run the complete repository gate before each release.

Verify the Bob image attestations against the bundle source revision.

Validate the resolved Compose model without printing its environment.

Require healthy Agent, Tunnel, backup, and metrics resources.

Require one recent encrypted Bob backup.

Run one canary Owner request before a production cutover.

Verify the request in D1 and the content-free telemetry systems.

## Consequences

Self-hosting gets a narrow and observable deployment Interface.

The host still needs Linux, Docker, KVM, storage monitoring, and controlled Coolify upgrades.

The KVM seam prevents Docker from changing the host network directly.

Coolify is not a secret authority, application data authority, or managed orchestration Interface.

Managed deployments can change hosts without changing Runtime policy.

## Sources

- [Coolify Docker Compose](https://coolify.io/docs/knowledge-base/docker/compose)
- [Coolify API authorization](https://coolify.io/docs/api-reference/authorization)
