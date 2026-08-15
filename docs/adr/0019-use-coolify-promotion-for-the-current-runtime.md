# ADR 0019: Use Coolify promotion for the current Runtime

- Status: Accepted
- Date: 2026-08-16
- Scope: Production promotion
- Supersedes: The current promotion owner in ADR 0018

## Context

ADR 0018 correctly removed release commits from source history.

It selected the Bob Control Plane as the promotion owner. The live Control Plane has no enrolled
Runner. The Runtime contract also has no accepted migration from its current Coolify project.

Making that incomplete path mandatory blocks normal releases.

## Decision

The protected Runtime release workflow promotes the immutable OCI bundle through the Coolify API.

The workflow verifies the bundle and source revision before it updates image pins. It checks the
deployed commit and authenticated Agent readiness after deployment.

Coolify deployment history is the current promotion history. The OCI bundle is the immutable
release identity.

The workflow reads a scoped Coolify API token from OpenBao with GitHub OIDC. It does not store the
token in GitHub.

The Bob Control Plane and Runner remain a migration target. They cannot own production until a
canary proves Runner enrollment, state migration, backup continuity, and independent assurance.

## Consequences

Source history contains no release-only commits.

Every green `main` commit can produce and deploy one immutable bundle.

A failed deployment restores the prior image pins and starts a rollback deployment.

The current deployment path matches the platform that runs Bob today.
