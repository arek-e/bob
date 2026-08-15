# ADR 0009: Use Coolify for the private application runtime

- Status: Superseded for managed orchestration by ADR 0014 and Control Plane ADR 0004
- Date: 2026-08-12
- Scope: Agent, Nango, backups, private ingress, and deployment control
- Supersedes: Kubernetes runtime ownership in ADR 0005
- Supersedes: Kubernetes OpenBao login in ADR 0001
- Nango ownership superseded by: ADR 0013
- Managed secret delivery amended by: ADR 0015

Migration status: Complete. The Kubernetes Bob runtime and temporary canary resources are retired.

## Context

Bob runs its private services on one Kubernetes node.

Argo CD, External Secrets, Cilium, and Kubernetes add control-plane work.

The current database and Bob backups also depend on that node.

Bob needs simple deployments that agents can inspect safely.

Coolify supports Git-based Compose deployments and an MCP server.

Coolify does not replace Cloudflare, OpenBao, or Bob's data authorities.

## Decision

This decision records the completed single-Owner migration.

Bob Runner is the managed deployment Interface.

Coolify can remain one hosting Implementation. It is not the managed orchestration authority.

Keep Cloudflare as the public edge and application data plane.

Keep OpenBao as the production secret authority.

Keep Alchemy as the owner of declared Cloudflare resources.

### Runtime ownership

Coolify owns these resources:

- the Bob agent application;
- the runtime Cloudflare Tunnel connector;
- Nango and its ephemeral Redis service;
- the Bob backup runner and schedule;
- the Nango PostgreSQL database and its backup schedule.
- the content-free Coolify host and container metrics collector.

Use `infra/coolify/compose.yaml` as the application stack source.

Create Nango PostgreSQL as a separate Coolify database resource.

This makes its S3 backup state visible through Coolify and MCP.

Do not publish container ports on the host.

The Tunnel connector is the only public application ingress.

Use immutable image digests for every production container.

The metrics collector sends only infrastructure metrics to the private OTLP endpoint.

It reads host statistics and backup modification times through read-only mounts.

It reads Docker statistics through the Docker socket as a non-root user.

The Docker socket group is specific to the fixed Coolify guest.

Do not add application logs, container environment values, or backup contents to this pipeline.

### Secret delivery

Use OpenBao AppRole when a Kubernetes service-account token is unavailable.

Mount the AppRole secret ID as a Docker secret file.

Never put the secret ID in a command argument or committed file.

Give the agent AppRole only the Pi credential policy.

Coolify holds runtime copies of the other required secrets.

OpenBao remains authoritative for those values.

An administrator synchronizes secret copies during bootstrap and rotation.

Regular deployment agents cannot read or change secret values.

### Agent access

Enable Coolify API and MCP access.

Run Coolify in a KVM guest on the existing Hetzner server.

Do not install Docker in the Kubernetes host operating system.

Bind guest forwards only to the host loopback address.

Publish the Coolify dashboard to the Tailnet with Tailscale Serve.

Give regular agents a team-scoped token with `read` and `deploy` permissions.

Do not give regular agents `read:sensitive`, `write`, or `root` permissions.

Load every token from an environment variable.

Use Codex write approvals for Coolify lifecycle tools.

Use the `deploy-bob-coolify` skill for deployment and rollback work.

The skill adds process rules. It does not add permissions.

### Backup ownership

Store Nango database backups in a dedicated private R2 bucket.

Copy every encrypted D1 and R2 archive to a second private R2 bucket.

Use the existing Cloudflare account for both backup buckets.

Use one bucket-scoped Object Read and Write token for each backup process.

Do not give either process R2 bucket administration permission.

Lock every backup object for 90 days. Expire each object after 180 days.

This design protects against host loss and compromised runtime credentials.

It does not protect against Cloudflare account loss or a Cloudflare-wide failure.

Keep the age identity outside the Coolify host.

Keep a local encrypted copy for fast recovery.

Test both restore paths before cutover.

### Completed migration stages

Use a dedicated virtual machine on the existing Hetzner server.

Give the guest 4 vCPUs, 12 GiB of memory, and a 50 GiB thin disk.

Keep Docker, its firewall rules, and its address pools inside the guest.

Forward OpenBao and OTLP traffic to their Kubernetes ClusterIPs through QEMU.

Do not expose Coolify ports on the server's public interfaces.

The Kubernetes runtime stayed available during acceptance.

The migration used a separate canary Tunnel and canary hostnames.

The migration did not connect both runtimes to the production Tunnel at the same time.

The production Tunnel moved after canary acceptance succeeded.

OpenBao and the telemetry backend stayed on the private host.

The Coolify runtime reaches them over the private network.

Move those platform services only in a separate reviewed change.

The retired Bob Kubernetes and Argo manifests are no longer release inputs.

## Verification

Run the complete repository gate before each release.

Verify both Bob image attestations against the release commit.

Validate the resolved Compose model without printing its environment.

Require healthy agent, Nango, Redis, Tunnel, and database resources.

Require one fresh Nango database backup in its locked R2 bucket.

Require one fresh encrypted Bob backup in its locked R2 bucket.

Run one canary owner request before cutover.

Run `List my reminders.` after cutover.

Verify the same request in D1, Tempo, and Loki.

## Consequences

Agents get a narrow and observable deployment interface.

Compose replaces most Kubernetes application manifests.

The platform still needs one Linux host, Docker, SSH, KVM, and storage monitoring.

Coolify remains a beta product and needs controlled upgrades.

The first stage still depends on Kubernetes for OpenBao and telemetry.

Kubernetes and Coolify share one physical failure domain.

The KVM boundary prevents Docker from changing Kubernetes networking.

The server needs strict disk alerts because the guest uses the same RAID volume.

Secret synchronization remains an administrator task.

Coolify is not a secret authority or an application data authority.

The backup copies share the Cloudflare account with the source data.

This accepted tradeoff reduces cost and account administration.

## Sources

- [Coolify Docker Compose](https://coolify.io/docs/knowledge-base/docker/compose)
- [Coolify MCP server](https://coolify.io/docs/integrations/mcp)
- [Coolify API authorization](https://coolify.io/docs/api-reference/authorization)
- [Coolify database backups](https://coolify.io/docs/databases/backups)
- [Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
