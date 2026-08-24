# Shared Runtime Cluster

This directory is the portable production contract for one shared Runtime Cluster.

The Runtime publishes these files in one immutable OCI artifact. The Control Plane Runner verifies every digest before Docker access.

The cluster runs one Core, one Channel, PostgreSQL, Redis, telemetry, and one scalable Agent Worker pool. PostgreSQL is authoritative. Redis stores pointer-only wake signals.

The Runner creates `bob-runtime-ingress`. Only Core and Channel join it. Agent Workers, PostgreSQL, Redis, and telemetry stay on the internal network.

## Production data inspection

Coolify and the Control Plane manage deployment and Runtime metadata. PostgreSQL remains the application data
authority. Do not use Coolify resource inspection as a substitute for a database read.

The Core environment projection must contain `PRODUCTION_DATA_INSPECTOR_SECRET` from OpenBao. The value must be
at least 32 characters and must be projected to the `core` consumer only.

The operator-only Runtime endpoints are:

- `GET /internal/production-data/summary?from=<iso>&to=<iso>&limit=<1-100>`
- `GET /internal/production-data/workflow/<correlation-id>?limit=<1-100>`

Send the caller token in `x-bob-caller-token`. The endpoints return bounded metadata. They do not return message
ciphertext, private Agent payloads, provider handles, or arbitrary SQL results.

The repository `pnpm maint` commands use their own maintenance composition. They open PostgreSQL through the
shared Database Module and call the Operations Module directly. They do not call Core HTTP routes and they do not
accept arbitrary SQL. Run them only from an approved Runtime network or with an approved scoped PostgreSQL access
path. Keep `DATABASE_URL` in the secret provider; never pass it as a command-line argument. The maintenance CLI
has its own `tools/.env.schema`; Varlock resolves the allowlisted database and data-protection fields from the
existing `ops/apps/prod/bob/runtime-cluster` OpenBao KV path. OpenBao policy must grant that read before the
fallback works. Local process values can override the provider for approved tests.

`pnpm maint migrate` uses the same migration program as the one-shot migration app. The metadata commands use
bounded time windows, correlation IDs, and row limits. The current internal HTTP endpoints remain a separate
remote inspection path for compatibility; they are not the maintenance CLI implementation.

## Headless agent API

The Core Runtime also exposes a private, read-only API for approved automation agents. It does not require the Bob
browser UI or a Better Auth session.

The Core environment projection must contain `BOB_HEADLESS_API_KEY`. Store the value in the OpenBao KV record at
`ops/apps/prod/bob/runtime-cluster` and project it to the Core consumer only. The projection identity needs read
access to the `ops/data/apps/prod/bob/runtime-cluster` policy path. Do not reuse `AGENT_CALLER_SECRET`,
`PRODUCTION_DATA_INSPECTOR_SECRET`, or an owner session secret.

Send the credential as `Authorization: Bearer <api-key>`. Use the canonical owner API route:

- `GET /api/production-data/messages?from=<iso>&to=<iso>&limit=<1-100>`

The route accepts either a Better Auth owner session or the scoped machine credential. `BOB_HEADLESS_OWNER_ID` is the
fixed Owner scope for the machine credential; callers cannot select an Owner through a query parameter or header.
Message text is decrypted through `ConversationStore`, with the same bounded time window and row limit. The API has
no mutation route, arbitrary SQL route, or cross-owner message export. Operator activity metadata remains available
only through the internal inspector routes above.

The API is a Core Runtime route on the existing private ingress. Keep the ingress behind the Runtime access boundary
and apply edge rate limits before exposing it to an automation agent. Rotating `BOB_HEADLESS_API_KEY` requires updating
the OpenBao value and restarting or redeploying Core so the environment projection changes.

Message text is available through `pnpm maint read-latest-messages` or the bounded
`pnpm maint read-all-messages --from <iso> --to <iso>` command. Both call the application
`ConversationStore.listMessages` Interface. They require one explicit owner, an explicit content approval value,
and the data-protection environment values. The all-message command is limited to 31 days and 1,000 messages.
It reports when the cap may have truncated the result, so operators can split the window.
Keep these commands narrow and owner-specific. They do not call the Core HTTP API. The canonical owner API route
above accepts either a Better Auth owner session or the scoped machine credential. An operator token cannot access it.

## Maintenance job boundary

Production maintenance runs as a one-shot `maintenance` job. The Compose profile provides the local Runtime
Adapter for this job. A Kubernetes or Argo Adapter should create one short-lived Job or pod with the same image
digest, command registry, secret policy, and environment contract.

The job must run in the target Runtime Cluster. The selected Runtime Target supplies its environment, region,
provider adapter, deployment profile, and release. The Control Plane snapshots the resolved target into the
maintenance Operation. The Runner passes these values, plus the target ID and execution ID, through the
`BOB_MAINTENANCE_*` context fields. The release ID must match the Runtime release that owns the database connection.
The CLI never guesses the target from the hostname in `DATABASE_URL`.

The job has no HTTP listener and no persistent replica. It waits for PostgreSQL, runs one reviewed command, emits
the command result, and exits. The runner owns retry, timeout, deduplication, and audit metadata. The maintenance
process owns command validation and calls the shared Database and Application Module Interfaces.

Agents use the same command names as operators. From the repository root, pass `--context <target-id>` and an
immutable `--image`. The Control Plane resolves the selected Runtime Target and receives the typed
`MaintenanceJobSpec` at `POST /v1/runtime-clusters/<cluster-id>/maintenance`. The assigned Runner claims the durable
Operation and starts the Compose job inside the target Runtime Cluster. The command returns content-free Operation
metadata. This path does not use the Bob UI, a browser terminal, or a Coolify terminal.

The Control Plane URL is `BOB_MAINTENANCE_CONTROL_PLANE_URL`. Varlock reads the operator token from the separate
`ops/apps/prod/bob/control-plane/operator-access` OpenBao record. The Control Plane stores job metadata only. Owner
scope and data-protection values remain in the Runtime Cluster maintenance secret projection; they are not command
arguments and are not copied into Control Plane state.

For the Compose Adapter, set `CORE_IMAGE_REFERENCE` to the selected `bob-core` digest reference and
`CORE_IMAGE_DIGEST` to its `sha256:<64-hex>` digest. The Adapter uses the full reference to start the Core project
image and passes only the digest into the maintenance process. Then run the job with the operations profile and pass
the command after the project image entrypoint:

```sh
docker compose --profile operations run maintenance context
docker compose --profile operations run maintenance read-all-messages \
  --from <iso> --to <iso>
```

Every maintenance command also accepts `--context <cluster-id>` and `--image <64-hex>` before or after the command
name. The CLI normalizes the hex to a `sha256:` digest and validates it against the injected job context. The runner
still selects the Core project image before pod creation; the command cannot pull, build, or switch its running image.

The `MAINTENANCE_ENV_FILE` contains the approved secret-zero or projected fields. Varlock resolves the allowlisted
OpenBao values from `tools/.env.schema`; the target job identity and OpenBao policy remain deployment Adapter
configuration. Do not place a database URL, token, or key on the command line.

## Image selection

The job runner selects the image before it creates the Job or pod. The Adapter resolves the Core project image
repository and the supplied digest into the full registry reference. The pod cannot build an image and the command
cannot select a mutable tag.

Use one of these Core project image sources:

- `runtime-release`: the `bob-core` image published with the Runtime release bundle.
- `commit-build`: a `bob-core` image built and pushed from an exact Git commit. This is the option for a migration
  or maintenance script prepared on a local branch. The runner must build, scan, push, and pin the resulting
  digest before it creates the job.
- `pinned-image`: an existing reviewed `bob-core` image digest selected for this operation.

The `bob-core` image is the project image. It contains the Core Runtime and the bundled `tools/` command registry,
so the maintenance job and the running application use the same project image. The existing `bob-migration`
one-shot image remains the release migration step when its source commit and database compatibility contract are
the intended ones. The `pnpm maint migrate` command uses the shared Database Module from the Core project image.

The job context records the image source, image digest, and source revision when the image came from a commit. This
lets an operator answer which code ran against which cluster and database.

## Release order

1. Pull and verify the release bundle.
2. Resolve exact OpenBao secret versions.
3. Run the one-shot migration.
4. Reconcile singleton services and Agent Worker replicas.
5. Run an encrypted backup.
6. Restore that backup into isolated PostgreSQL.
7. Observe the release for 30 minutes.

## Recovery objectives

The Control Plane requests a verified backup every four hours. The target recovery point is four hours.

Each backup includes PostgreSQL and encrypted Object Storage. Restic applies daily, weekly, and monthly retention.

The restore verifier restores the newest snapshot into isolated PostgreSQL. It checks snapshot hashes, restores the database, and reads an application table.

The target restore time is 60 minutes. Operators must test this target after host, storage, or database changes.

Redis uses AOF. A total Redis loss does not lose authoritative work. PostgreSQL outboxes reconstruct Agent Run and delivery wake signals.
