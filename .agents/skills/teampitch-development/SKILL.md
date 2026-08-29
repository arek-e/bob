---
name: teampitch-development
description: Use for local development, worktrees, ports, process lifecycle, and shared Teampitch development tooling.
---

<!-- teampitch:dev-tools managed -->

# Shared Teampitch development

Use the repository's package manager to invoke `wt` from `@teampitch/dev-tools`.

## Workflow

1. Read the root `AGENTS.md` and the relevant package manifest.
2. Run `wt status --all --json` before diagnosing a port or process issue.
3. Use `wt init` for an existing checkout or `wt new` for a new worktree when the repository supports worktree allocation.
4. Use `wt open <service> --json` for the current HTTP route. Use the reported URL instead of reconstructing a port.
5. Use `wt doctor --json` for listener conflicts and `wt logs <service>` for captured development logs.
6. Use `wt stop` when the checkout owns a runtime and `wt prune --dry-run` before removing stale leases.

`wt` owns instance allocation, declared ports, process cleanup, and Portless routes. Repository adapters own commands, migrations, and environment names.

## Completion

Finish with a status report that names the checkout, instance, service URLs, validation command, and any remaining owner or listener.
