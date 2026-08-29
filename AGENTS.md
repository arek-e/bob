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

Bob-owned dependency-injection factories use the `createX` naming pattern. Preserve names defined by external
libraries, such as `ManagedRuntime.make` and `Schema.makeFilter`.

Tailwind class sorting uses `apps/ui/src/styles/app.css`. It also handles `cn`, `clsx`, and `cva`.

Lefthook formats and lints staged files before each commit. CI remains the authoritative check.

Keep generated files, secrets, build output, and local runtime state out of commits.

## Change discipline

Preserve unrelated worktree changes. Keep changes inside the requested package or domain.

Update the relevant tests when behavior changes. Report failed checks and their cause.

## Architecture guardrails

- Treat `CONTEXT.md` and the current implementation as authoritative.
- Register Capability Modules and Context source Modules in static, reviewed deployment profiles.
- Keep every Tool in exactly one Capability Module.
- Update Tool definitions, safety metadata, and conformance tests together.
- Keep domain Modules authoritative for policy and mutation rules.
- Keep ContextStore authoritative for privacy, budgets, deduplication, and assembly.
- Keep telemetry read-only and fail-open.
- Do not add runtime discovery, package-installed Modules, self-registration, or hot reload.
- Do not add mutable lifecycle hooks without a defined lifecycle, owner, and cleanup path.
- Update `CONTEXT.md` and the relevant README or feature documentation when architecture changes.

<!-- teampitch:dev-tools bootstrap:start -->

## Shared Teampitch workflow

This repository uses `@teampitch/dev-tools` for local development and agent workflow.

- Read [the shared development skill](.agents/skills/teampitch-development/SKILL.md) before local
  development, worktree, or port work.
- Use the repository package manager and its `wt` command for local runtime lifecycle work.
- Read [the shared anti-slop skill](.agents/skills/teampitch-anti-slop/SKILL.md) before changing
  TypeScript or JavaScript patterns covered by the repository lint gate.
- Read [the shared deployment skill](.agents/skills/teampitch-deployment/SKILL.md) before changing
  deployment, infrastructure, OpenBao, ArgoCD, Cloudflare, or release behavior.
- Bootstrap profile: `deployment`.

Keep repository-specific rules outside this generated section. Re-run `dev-tools bootstrap` after
upgrading the shared package.
<!-- teampitch:dev-tools bootstrap:end -->
