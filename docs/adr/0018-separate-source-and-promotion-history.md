# ADR 0018: Separate source history from promotion history

- Status: Accepted
- Date: 2026-08-15
- Scope: Runtime release publication and managed promotion
- Supersedes: Release-manifest commits described by ADR 0014

## Context

The Runtime release workflow wrote image digests to a later commit on `main`.

That commit mixed source history with deployment state. It also competed with merge queues.

Future promotion systems must move one immutable release through independent environments.

## Decision

The Runtime source repository does not create release-only commits.

One successful `main` build publishes an immutable OCI release bundle.

The bundle binds these values:

- the reviewed source revision;
- the configuration revision;
- the deployment contract URI and digest;
- every immutable Runtime image digest.

The canonical bundle JSON has one SHA-256 content identity.

The public Runtime workflow publishes the bundle. It has no production identity.

The private Control Plane promotes the exact bundle digest. It stores desired and accepted release state.

A future GitOps controller can write environment state to a separate environment repository.

The application source merge queue does not contain promotion commits.

## Consequences

Source history records what Bob built.

Promotion history records where Bob ran the bundle.

Staging and production can select different bundles.

Rollback selects a prior accepted bundle. It does not revert source history.

The old `infra/coolify/release.json` file and its delta verifier are removed.

Reviewed third-party image pins remain in `infra/coolify/base-images.json`.
