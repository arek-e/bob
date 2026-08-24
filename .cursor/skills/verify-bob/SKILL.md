---
name: verify-bob
description: "Verify Bob Runtime through the maintenance CLI, Core HTTP API, or private owner UI after changes to tools, message access, settings, routes, or deployment context."
---

# Verify Bob Runtime

Use this skill to prove Bob through a real user-facing path. The primary surface is the short-lived `pnpm maint` Ink CLI because it runs the reviewed TypeScript maintenance functions directly. The secondary surfaces are the Core HTTP API and the private owner UI served by Core.

Read [features/README.md](./features/README.md) before driving a feature. Use one feature recipe for each proof. Keep production message content out of committed evidence.

## Launch

Run from the repository root.

For the primary CLI surface, launch and check readiness with:

```sh
pnpm maint help
```

Readiness means exit code `0` and output that starts with `Usage: pnpm maint`. This process exits after it renders the Ink frame. Each later command starts its own short-lived process, so no shared CLI session exists to attach to or clean up.

The help path skips Varlock secret resolution. Database commands need the maintenance contract in `tools/.env.schema`, an approved owner, and the data-protection values. Do not use a database command as a readiness check.

To verify the secondary Core HTTP and UI surface, start the repository stack only when its local environment is configured:

```sh
docker compose up -d
curl --fail --silent --show-error http://127.0.0.1:8788/health
```

Readiness means the response is JSON with `healthy: true`, `service: "core-runtime"`, and `version: 1`. The UI is then at `http://127.0.0.1:8788/`. First setup is `http://127.0.0.1:8788/setup`; it requires the local `SETUP_TOKEN` and creates the owner login. Sign in at `/sign-in` and use `/settings` after setup. Teardown is `docker compose down`; keep volumes when the next run needs the local data.

Never attach to a Core process or port that this run did not start. Do not run two verification stacks on the shared `127.0.0.1:8788` port.

## Doctor

Run the bundled read-only doctor before a CLI proof:

```sh
bash .cursor/skills/verify-bob/helpers/verify-bob.sh doctor
```

The doctor checks that `node` and `pnpm` are available, `pnpm maint help` exits successfully, and the default `pnpm maint context` identifies the local development target. It prints versions and stable status only. It does not print environment values, OpenBao tokens, database URLs, or message data.

For a stack proof, also run:

```sh
curl --fail --silent --show-error http://127.0.0.1:8788/health
```

If the doctor fails, stop and report the command, exit code, and unmet precondition. Do not switch to a different entry point and call the feature verified.

## Drive

Use the feature recipe as the source of truth for the user path. Start every CLI recipe from the repository root.

The maintenance command registry is the agent interface:

```sh
pnpm maint help
pnpm maint <command> --help
pnpm maint context
pnpm maint read-latest-messages --from <iso> --to <iso> --limit <1-100>
pnpm maint read-all-messages --from <iso> --to <iso>
pnpm maint read-latest-messages --context <cluster-id> --image <64-hex>
```

Use `context` and command help for discovery. These paths do not open PostgreSQL. Data commands call the reviewed Application Module Interfaces through the maintenance runtime. They do not call Core HTTP routes and do not accept arbitrary SQL.

Use `--context` for the Runtime Cluster identifier. Use `--image` for exactly 64 hexadecimal characters. The CLI normalizes the image to `sha256:<hex>`. For agent mode, the Control Plane resolves the Runtime Target and release, then schedules the same command as a cluster job. Use only a target ID and image digest supplied by the deployment system. Do not guess a production target or digest.

For the secondary HTTP surface, use the normal owner API. The health route is `GET /health`. The owner message route is `GET /api/production-data/messages?from=<iso>&to=<iso>&limit=<1-100>`. A browser session authenticates normal owner requests. A headless caller may send `Authorization: Bearer ${BOB_HEADLESS_API_KEY}` when the deployment has `BOB_HEADLESS_OWNER_ID` configured. The API key is a secret; keep it in the environment and out of transcripts.

For the UI surface, use the exact routes `/setup`, `/sign-in`, and `/settings`. Prefer labels and visible text such as `Email`, `Password`, `Continue with email`, `Local time and language`, `Save`, `Accounts`, `Messaging`, and `Sendblue help`. The feature map records the observable result for each path.

## Evidence

Store durable proof under:

```text
.cursor/skills/verify-bob/artifacts/
```

CLI proof includes the literal command, stdout, stderr, exit code, feature ID, and the resulting JSON or text. UI proof includes the route, user action, an accessibility snapshot, and a screenshot with Bob identity visible. API proof includes the method, path, status code, and redacted response body. A message read must also prove its bounded window, owner scope, and result count without storing private message bodies.

Exercise the real user path. Capture the action and the resulting state. Check side effects with a second read-only view when a feature changes state. Use a mock only where the production boundary already isolates the external system. A dry-run name is not proof: observe what it touched.

Do not put setup tokens, API keys, OpenBao values, database URLs, owner identifiers, decrypted message text, or unredacted production responses in this directory. If a local run needs sensitive output, keep it in an operator-controlled temporary file and record only redacted metadata in the artifact.

The bundled proof helper writes a safe transcript for the context feature:

```sh
bash .cursor/skills/verify-bob/helpers/verify-bob.sh prove
```

That transcript is durable and contains no database or message data.

## Cleanup

Run cleanup after every proof attempt, including a failed attempt:

```sh
bash .cursor/skills/verify-bob/helpers/verify-bob.sh cleanup
```

The CLI proof starts no persistent process. The helper checks that the proof artifact remains and reports that no CLI process needs teardown. If the run started Compose, stop only the stack created by that run:

```sh
docker compose down
```

Do not delete `.cursor/skills/verify-bob/artifacts/`. Cleanup removes processes and scratch state, never evidence. After cleanup, confirm the named artifact still exists.

## Helpers

The repository ships one executable helper at `.cursor/skills/verify-bob/helpers/verify-bob.sh`:

```sh
bash .cursor/skills/verify-bob/helpers/verify-bob.sh doctor
bash .cursor/skills/verify-bob/helpers/verify-bob.sh prove
bash .cursor/skills/verify-bob/helpers/verify-bob.sh cleanup
```

`doctor` checks readiness. `prove` drives `pnpm maint context` and captures a safe transcript. `cleanup` verifies that the transcript survived. The helper does not resolve secrets or connect to PostgreSQL.

## Completion

A proof is complete only when launch, doctor, one feature recipe, evidence capture, cleanup, and post-cleanup evidence checks all pass. Report skipped authenticated paths with their unmet precondition. Report the exact path that was verified.

Use `/maintain-verification-skill` when routes, commands, labels, ports, or observable behavior change.
