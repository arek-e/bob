# Inspect runtime context

The `context` command shows the explicit environment, cluster, deployment profile, execution mode, Runtime Target, release, and image context that a maintenance process receives.

## Sub-features

- `local-context`: inspect the default development/local context.
- `cluster-context`: inspect resolved target fields inside a cluster job.
- `image-context`: verify the immutable Core image source and digest when present.

## How to get to it (user POV)

- Run `pnpm maint context` for the local human path.
- Run a maintenance command with `--context <cluster-id> --image <64-hex>` for the agent path; the Control Plane resolves the target before the job runs.
- In a cluster job, run `pnpm maint context` to print the runner-provided context.

## Driving it with the Bob maintenance CLI

Preconditions:

- The checkout is the repository under test.
- Node and pnpm are available.
- For the local path, no database or OpenBao credential is required.

- Action: run `pnpm maint context`.
  Result: exit code `0`; JSON contains `schemaVersion: "bob.maintenance-context.v1"`, `environment: "development"`, `clusterId: "local"`, `deploymentProfileId: "core"`, and `mode: "local"`.
- Action: inspect a cluster-job transcript that was created by the Control Plane.
  Result: `executionContext` contains the resolved environment, cluster, deployment profile, release, Runtime Target, and image fields. The image digest is `sha256:` plus 64 lowercase hex characters.
- Action: run `bash .cursor/skills/verify-bob/helpers/verify-bob.sh prove`.
  Result: `.cursor/skills/verify-bob/artifacts/maintenance-context.txt` records the command, output, and exit code.

## Gotchas

- `context` does not open PostgreSQL or resolve database secrets.
- A local context is not evidence that a staging or production target is reachable.
- A target name must come from the Control Plane or deployment configuration. Do not infer it from `DATABASE_URL`.
- A commit-built image needs its source revision in the cluster-job context.
- Do not store target access-policy values or private release metadata in shared evidence.
