# Run a cluster-scoped maintenance job

An agent can use the same reviewed maintenance command as a human while selecting a Runtime Cluster and immutable Core project image. The Control Plane resolves the target and schedules a job near the target runtime.

## Sub-features

- `target-selection`: select a Runtime Cluster with `--context <cluster-id>`.
- `image-selection`: select a Core project image with `--image <64-hex>`.
- `operation-request`: receive an execution ID and Control Plane operation ID.
- `job-context`: run `pnpm maint context` inside the assigned job and inspect resolved fields.

## How to get to it (user POV)

- Run `pnpm maint migrate --context <cluster-id> --image <64-hex>` for a remote migration request.
- Run `pnpm maint read-latest-messages --context <cluster-id> --image <64-hex>` for a remote message-read request.
- Use `pnpm maint <command> --help` to inspect the same command before adding the flags.

## Driving it with the Bob maintenance CLI

Preconditions:

- The Control Plane URL and operator credential are resolved through `tools/.env.schema`.
- The cluster ID is a known Runtime Target ID.
- The image input is exactly 64 hexadecimal characters and identifies an approved `bob-core` image.
- A staging target is available for proof. Use production only with an explicit operational change window.

- Action: run `pnpm maint read-latest-messages --context <cluster-id> --image <64-hex>`.
  Result: the process is non-interactive, returns exit code `0`, and prints JSON with `executionId`, `operationId`, `clusterId`, `command`, and `status: "requested"`.
- Action: inspect the operation in the Control Plane and the assigned job logs.
  Result: the job uses the resolved release, target reference, deployment profile, image digest, and command name. The runner creates the pod in the selected Runtime Cluster.
- Action: in the assigned job, run `pnpm maint context`.
  Result: the context contains the runner-provided environment, target, release, execution ID, and image metadata.

## Gotchas

- `--context` does not mean “run locally against this database”. It requests a cluster job.
- `--image` accepts raw hex only. The CLI adds `sha256:`.
- Do not guess IDs, use a provider terminal, or copy a database URL into the command.
- A remote request is not proof that the job completed. Check the operation and job result.
- Do not use a production target for a verification proof when staging can prove the same behavior.
