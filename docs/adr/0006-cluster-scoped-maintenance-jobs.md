# ADR 0006: Cluster-scoped maintenance jobs

Status: Accepted
Date: 2026-08-24

## Context

The maintenance CLI reads the same PostgreSQL and Application Module Interfaces as the Runtime. A local shell
cannot resolve the private `postgresql` service name used by a production cluster. A local database tunnel would
also weaken the boundary between an operator workstation and the Runtime network.

Maintenance work also needs controlled image selection. A migration can need the image from the current release,
an image built from a candidate Git commit, or an already reviewed image digest. A mutable tag or an image that
does not contain the project command registry would make the operation hard to audit.

## Decision

Run production maintenance as a short-lived job or pod inside the target Runtime Cluster. A flagged agent invocation
selects a Runtime Target with `--context` and sends the typed job to the private Control Plane API. The Control Plane
resolves the provider-neutral target record from the Runtime Cluster specification, stores the durable Operation, and
the assigned Runner creates the provider job. The job uses the same
network, PostgreSQL service, OpenBao policy, release profile, and data-protection contract as the Runtime. It does
not listen for HTTP traffic or become a persistent Runtime role.

Define one provider-neutral `MaintenanceJobSpec` in the Runtime Control contract. It contains the target cluster,
deployment profile, release, execution ID, immutable Core image digest, image source, optional source Git revision,
the `core` project image name, and one static maintenance command with arguments. A Coolify Compose Adapter and a
Kubernetes or Argo Adapter may implement the job with different provider objects, but they must preserve this
contract.

The maintenance job always runs the `bob-core` project image. The supported image sources are:

- `runtime-release`: the `bob-core` image in the published release bundle;
- `commit-build`: a `bob-core` image built and pushed from one exact Git commit;
- `pinned-image`: another reviewed `bob-core` image selected by digest.

The runner resolves the Core project image repository and pins the digest before it creates the job. The job receives
the same digest selection and target as `MaintenanceExecutionContext`. The CLI accepts only 64 hexadecimal image
characters and normalizes them to the canonical `sha256:` digest. It requires `--context` and rejects mutable image
tags, targets without explicit metadata, and commit-built images without a source revision. It never derives the
target from `DATABASE_URL` or parses environment from a target name.

The Runtime Target records provider, region, execution adapter, deployment profile, access-policy reference, and
configuration source metadata. Terraform or another infrastructure publisher may update the desired target through
the Control Plane. The maintenance CLI does not read Terraform state or provider credentials. A future PIM flow may
authorize a request against the target's access-policy reference, but PIM does not define the target or its environment.

Keep the release migration step on the existing one-shot migration role. The maintenance `migrate` command uses
the same shared Database Module from the `bob-core` project image as every other maintenance command.

## Consequences

The production path uses the real cluster DNS and network boundary. It does not require a local database tunnel.

An operator can run a pre-release migration from a local branch after building and pushing a digest-pinned image.
The runner must record the source commit, image digest, target cluster, release, command, and outcome.

The Control Plane and job runner own provider scheduling, retry, timeout, deduplication, and content-free Operation
state. The maintenance CLI owns command parsing, safety limits, and direct calls to the shared Database and
Application Module Interfaces. The flagged agent path does not use the Bob browser UI or a provider terminal.

The Runtime release does not publish a dedicated maintenance image. The `bob-core` project image contains the
bundled command registry, so the maintenance job and Core Runtime use the same image built from the same project
revision.
