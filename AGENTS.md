# Agent guide

Read [CONTEXT.md](CONTEXT.md) before changing architecture or domain behavior.

## Validation commands

- `pnpm format` formats the repository with Oxfmt.
- `pnpm format:check` checks formatting without writing files.
- `pnpm lint` runs Oxlint with correctness rules as errors.
- `pnpm lint:fix` applies safe Oxlint fixes.
- `pnpm typecheck` checks all workspace packages.
- `pnpm test` runs the unit and Worker test suites.
- `pnpm check` runs the full repository gate.
- `pnpm hooks:install` installs Lefthook into the local Git repository.
- `pnpm hooks:run` runs the pre-commit checks on staged files.

Run the smallest relevant check after each change. Run `pnpm check` before handoff.

## Code quality

Oxfmt owns formatting, import order, Tailwind class order, and `package.json` field order.

Oxlint owns correctness rules and import safety. Do not add disable comments to hide a finding.

Tailwind class sorting uses `apps/ui/src/styles/app.css`. It also handles `cn`, `clsx`, and `cva`.

Lefthook formats and lints staged files before each commit. CI remains the authoritative check.

Keep generated files, secrets, build output, and local runtime state out of commits.

## Change discipline

Preserve unrelated worktree changes. Keep changes inside the requested package or domain.

Update the relevant tests when behavior changes. Report failed checks and their cause.
