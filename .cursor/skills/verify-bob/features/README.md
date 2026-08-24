# Bob verification map

This directory is the maintained source for verifying Bob Runtime. Read this index before driving the app, then use the matching feature file as the recipe.

## Baseline preconditions

- Run every command from the Bob repository root.
- Use `pnpm maint help` as the primary launch check. It is short-lived and needs no secrets.
- Run `bash .cursor/skills/verify-bob/helpers/verify-bob.sh doctor` before a CLI proof.
- Treat message reads as private-data operations. They need an explicit owner and `BOB_MAINTENANCE_CONTENT_APPROVAL=owner-approved`.
- Use only a deployment-provided Runtime Cluster ID and 64-hex Core image digest for agent mode.
- Start Compose only when its local environment is configured. The stack owns `127.0.0.1:8788`.
- Never drive a process or port that this verification run did not start.

## Driving conventions

- Start each recipe from its stated precondition.
- Use the exact `pnpm maint` commands and route paths in the recipe.
- Prefer command output, HTTP status and JSON, accessible names, and visible labels over implementation details.
- Keep secrets and private message bodies out of durable evidence.
- Capture the action and resulting state. Use a second read-only view for mutations.
- Run cleanup after every attempt. Cleanup must preserve `.cursor/skills/verify-bob/artifacts/`.

## Proof and skip reporting

- CLI proof includes command, stdout, stderr, exit code, feature ID, and result.
- API proof includes method, path, status, and a redacted response body.
- UI proof includes route, action, accessibility snapshot, and screenshot with Bob identity visible.
- Report the exact entry point used. Do not report a CLI proof as UI or API proof.
- Report a skipped path with its attempted command and unmet precondition.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph that describes the user-visible behavior. It then uses exactly four H2 sections in this order: `Sub-features`, `How to get to it (user POV)`, `Driving it with <harness>`, and `Gotchas`. Replace `<harness>` with the real harness used by that feature.

## Features

- [Discover maintenance commands](./maintenance-discovery.md) covers the command registry, command help, and shared options.
- [Inspect runtime context](./runtime-context.md) covers the local context view and the fields resolved for a cluster job.
- [Read owner messages](./owner-message-reading.md) covers direct ConversationStore reads, bounded windows, and the normal headless API route.
- [Set up and manage the owner](./owner-settings.md) covers protected setup, sign-in, settings, and the normal owner API.
- [Run a cluster-scoped maintenance job](./cluster-maintenance-job.md) covers `--context`, `--image`, Control Plane resolution, and job proof.
