# Bob maintenance CLI

Run reviewed maintenance commands from the repository root:

```sh
pnpm maint help
pnpm maint read-latest-messages --base-url <private-core-url>
pnpm maint summarize-activity --base-url <private-core-url>
pnpm maint inspect-workflow \
  --base-url <private-core-url> --correlation-id <correlation-id>
```

`read-latest-messages` reads recent message content through the existing Better Auth owner session. It reads
the cookie from `BOB_OWNER_SESSION_COOKIE` by default. Use `--session-cookie-env` when the secret provider uses
another environment variable name. Never put a cookie on the command line.

`summarize-activity` and `inspect-workflow` read bounded metadata through the private Runtime API. They read
the operator token from `PRODUCTION_DATA_INSPECTOR_TOKEN` by default. Use `--token-env` when the secret provider
uses another environment variable name. Never put a token on the command line.

The commands are non-interactive and agent-usable. Data commands return JSON and use exit code `0` on success or
`1` on a safe failure. Use `pnpm maint help` or `pnpm maint <command> --help` for discovery.

## Add a maintenance command

Each command is a module under `tools/maintenance/`. It exposes a name, a description, help text, and a `run`
function. Register the module in `tools/cli.tsx`, add tests under `tools/test/`, and document any production access
or safety rules with the command.

The registry is the command interface. Ink renders the terminal UI. The CLI does not load arbitrary file paths or
execute arbitrary shell commands. A future PIM command can use the same seam after its scope, preview behavior, and
write policy are defined.

## Framework choice

Ink is the selected terminal renderer because it provides React components, hooks, layout, input, and testable
frames. Commander is the fallback if option parsing grows beyond the local typed registry. oclif is reserved for a
future need for independently installed plugins. Clack is optional for prompts, but should not share terminal input
ownership with Ink. Clipanion was rejected because its official repository has no releases and its visible commit
history is stale for this project.

See [the framework comparison](../docs/research/cli-framework-comparison.md) for primary-source links.
