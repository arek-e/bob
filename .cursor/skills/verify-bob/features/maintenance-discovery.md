# Discover maintenance commands

An operator or agent can discover Bob's reviewed maintenance commands without opening PostgreSQL, resolving secrets, or using a browser.

## Sub-features

- `help`: list the command registry and shared options.
- `command-help`: inspect one command's arguments and safety contract.
- `shared-options`: discover `--context <cluster-id>` and `--image <64-hex>`.

## How to get to it (user POV)

- Run `pnpm maint help` from the repository root.
- Run `pnpm maint <command> --help` for `migrate`, `read-latest-messages`, `read-all-messages`, `summarize-activity`, or `inspect-workflow`.
- Use `--context <cluster-id>` and `--image <64-hex>` when the same command must run through the Control Plane.

## Driving it with the Bob maintenance CLI

Preconditions:

- The checkout is the repository under test.
- Node and pnpm are available.

- Action: run `pnpm maint help`.
  Result: exit code `0`; output contains `Usage: pnpm maint`, `Global options`, `Commands`, and `Use \`pnpm maint <command> --help\``.
- Action: run `pnpm maint read-latest-messages --help`.
  Result: exit code `0`; output states that the command calls `ConversationStore` directly, requires owner approval, and lists the common context and image options.
- Action: run `pnpm maint context`.
  Result: exit code `0`; output is JSON with an `executionContext` object.

## Gotchas

- Help and context are discovery paths. They do not prove that the database is reachable.
- `--context` names a Runtime Cluster. It is not an environment flag.
- `--image` takes only 64 hexadecimal characters. Do not pass `sha256:`.
- `--environment` and `--deployment-profile` are removed options.
- Keep help transcripts free of environment dumps and credentials.
