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

## Architecture guardrails

- Treat `CONTEXT.md` and accepted ADRs as authoritative.
- Register Capability Modules and Context source Modules in static, reviewed source lists.
- Keep every Tool in exactly one Capability Module.
- Update Tool definitions, safety metadata, and conformance tests together.
- Keep domain Modules authoritative for policy and mutation rules.
- Keep ContextStore authoritative for privacy, budgets, deduplication, and assembly.
- Keep telemetry read-only and fail-open.
- Do not add runtime discovery, package-installed Modules, self-registration, or hot reload.
- Do not add mutable lifecycle hooks without an accepted ADR.
- Update `CONTEXT.md` and the relevant ADR when architecture changes.
