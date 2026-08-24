# Bob maintenance CLI

Run reviewed maintenance commands from the repository root:

```sh
pnpm maint help
pnpm maint context
pnpm maint migrate
pnpm maint read-latest-messages
pnpm maint read-all-messages --from <iso> --to <iso>
pnpm maint summarize-activity
pnpm maint inspect-workflow \
  --correlation-id <correlation-id>
pnpm maint read-latest-messages \
  --context <cluster-id> \
  --image <64-hex>
```

Every command accepts these shared options before or after the command name:

```sh
pnpm maint --context <cluster-id> context
pnpm maint read-latest-messages \
  --context <cluster-id> \
  --image <64-hex>
```

`--context` selects a Runtime Target ID. The Control Plane resolves its environment, region, provider adapter,
Deployment Profile, access-policy reference, and desired release. The CLI never infers these values from the target
name or `DATABASE_URL`. `--image` supplies only the 64 hexadecimal characters of the immutable Core project image
digest. The CLI normalizes it to the canonical `sha256:` digest. Supplying agent flags creates a typed Control Plane
operation instead of opening PostgreSQL locally. The Control Plane and assigned Runner resolve the image before they
create the job. In `cluster-job` mode, the pod receives the resolved values through its private context contract.

Today, the Runtime Target is embedded in the Runtime Cluster specification, so its ID aliases the cluster ID. The
Control Plane endpoint keeps this lookup behind a target boundary. A future target registry can change the backing
store without changing the maintenance command contract.

The CLI has its own maintenance composition. It opens the shared PostgreSQL Database Module and calls selected
Application Module Interfaces directly. It does not call Core HTTP routes and it does not open an arbitrary SQL
console.

The CLI has its own Varlock contract at `tools/.env.schema`. For database commands, `pnpm maint` runs the command
through Varlock first. Varlock uses local process overrides when present. Otherwise, it reads the allowlisted
database and data-protection fields from the `ops/apps/prod/bob/runtime-cluster` OpenBao KV path. Local OpenBao
authentication uses the Bao CLI token. Trusted automation can use the imported `BAO_JWT_ROLE` OIDC path.
Flagged agent commands use `BOB_MAINTENANCE_CONTROL_PLANE_URL` and read the operator token from
`ops/apps/prod/bob/control-plane/operator-access#OPERATOR_TOKEN`. The token is sent only as an Authorization header.

Help commands skip secret resolution, so agents can discover the interface without database or OpenBao access.
Run `pnpm env:check:maint` to validate the maintenance contract. Regenerate the typed schema module with
`pnpm exec varlock codegen --path tools` after schema changes.

Every command receives a maintenance execution context. The human path defaults to development, the local target,
the core profile, and local mode. Agent invocations set the target with `--context` and `--image`. The Control Plane
resolves the Runtime Target and release. A cluster job also sets the resolved target region, provider, runtime
adapter, target reference, access-policy reference, and source metadata, together with
`BOB_MAINTENANCE_RELEASE_ID`, `BOB_MAINTENANCE_EXECUTION_ID`, `BOB_MAINTENANCE_IMAGE_SOURCE`, and
`BOB_MAINTENANCE_IMAGE_DIGEST`. A commit-built image also sets `BOB_MAINTENANCE_SOURCE_REVISION`. The context
identifies where the command runs and which immutable Core project image runs it. It does not infer a target from
`DATABASE_URL`.

`pnpm maint context` prints this context without opening the database. Agent commands use the same command name as
human commands; the target flags select a one-shot production job or pod. The job runner must create it in the target
Runtime Cluster and must pass the same release ID that the cluster runs. Image options must use 64 hexadecimal
characters. The image source is `runtime-release` for the
published `bob-core` image, `commit-build` for a `bob-core` image built from a selected Git commit, or
`pinned-image` for an already-built reviewed `bob-core` image.

`DATABASE_URL` is required for commands that use the database. `migrate` uses the same PostgreSQL migration
program as the Runtime migration app. Migration files default to `packages/db/service/migrations`; set
`BOB_MIGRATIONS_FOLDER` for the packaged Core project image.

`summarize-activity` and `inspect-workflow` call the Operations Module directly. They use the same bounded query
rules as the Runtime inspector.

`read-latest-messages` calls `ConversationStore.listMessages` directly. It requires `BOB_OWNER_ID` and an
explicit `BOB_MAINTENANCE_CONTENT_APPROVAL=owner-approved` value. The command needs the data-protection
environment values before it can decrypt message text. Keep this command narrow and owner-specific.

`read-all-messages` uses the same application Interface for one owner, but requires an explicit UTC window. The
window cannot exceed 31 days and the result cannot exceed 1,000 messages. It is not a cross-owner export.
The JSON result marks `possiblyMore=true` when the message cap is reached; split the time window before reading
the next bounded result.

The human path uses the Ink terminal presentation. Flagged agent commands are non-interactive and return a Control
Plane Operation ID. Data commands return JSON and use exit code `0` on success or `1` on a safe failure. The same
command name is used in both paths. Neither path opens a provider terminal or a browser. Use `pnpm maint help` or
`pnpm maint <command> --help` for discovery.

## Add a maintenance command

Each command is a module under `tools/maintenance/`. It exposes a name, a description, help text, and a `run`
function. Commands receive `getRuntime()`. Use that runtime to call a reviewed Application Module Interface or
the shared Database Module. Register the module in `tools/cli.tsx`, add tests under `tools/test/`, and document
any production access or safety rules with the command.

The registry is the command interface. Ink renders the terminal UI. The CLI does not load arbitrary file paths or
execute arbitrary shell commands. A future PIM command can use the same maintenance composition after its scope,
preview behavior, and write policy are defined.

## Framework choice

Ink is the selected terminal renderer because it provides React components, hooks, layout, input, and testable
frames. Commander is the fallback if option parsing grows beyond the local typed registry. oclif is reserved for a
future need for independently installed plugins. Clack is optional for prompts, but should not share terminal input
ownership with Ink. Clipanion was rejected because its official repository has no releases and its visible commit
history is stale for this project.
