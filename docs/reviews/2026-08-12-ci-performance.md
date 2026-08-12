# CI performance baseline

Date: 2026-08-12

Baseline commit: `943122f3d2e539567b066b3d6412f1bcb0d4fdbc`

## Stop rule

Keep an optimization when it supports a critical-path saving of at least 10 seconds. Stop after the audit finds no such change.

## GitHub Actions baseline

The baseline uses successful runs from the same commit.

| Workflow       | Run                                                                   | Wall time | Main measured costs                         |
| -------------- | --------------------------------------------------------------------- | --------: | ------------------------------------------- |
| CI             | [31542661412](https://github.com/arek-e/bob/actions/runs/31542661412) |     274 s | `verify` 263 s; trusted plan 152 s          |
| Release images | [31543018823](https://github.com/arek-e/bob/actions/runs/31543018823) |     888 s | agent 407 s; backup 429 s; verification 7 s |

The last five successful CI push runs have a median wall time of 182 seconds.

The CI `pnpm check` step took 213 seconds. Type checking took 56 seconds. Tests took 94 seconds. Builds took 39 seconds.

The trusted plan took 36 seconds to scan 111,863 files. The scan included `node_modules`. Its full build took 41 seconds.

The image workflow exported the agent cache for 166 seconds. It exported the backup cache for 219 seconds. These exports added 385 seconds.

## Local command baseline

The local host has 12 CPU cores. Dependencies were warm.

| Command              |      Baseline |
| -------------------- | ------------: |
| `pnpm check`         | 79.29–82.93 s |
| `pnpm typecheck`     | 19.39–20.28 s |
| `pnpm test`          |       24.70 s |
| `pnpm build`         | 13.98–14.37 s |
| artifact builds only |   4.57–4.90 s |

The trusted scan now takes 0.67 seconds locally. It scans tracked files and generated production artifacts.

The changed serial `pnpm check` took 71.10 to 73.88 seconds. The Actions matrix runs its slow lanes in parallel.

The slowest local matrix command takes 20.28 seconds. The command-only critical path saves at least 53.60 seconds.

## Changes

- Run independent CI gates on separate runners. Keep the `verify` status as the final gate.
- Remove duplicate `tsc` build commands. These commands use `noEmit` and repeat the type-check gate.
- Build only production artifacts before the trusted infrastructure plan.
- Scan tracked files and production artifacts. Do not scan installed dependencies.
- Publish the agent and backup images in parallel.
- Export minimum BuildKit cache data. Keep provenance and SBOM output unchanged.
- Install only each image's dependency closure.
- Run JavaScript builds on the native BuildKit platform. Keep both target runtime platforms.

## Expected result

The CI verification path should take 100 to 130 seconds. This saves 52 to 82 seconds against the recent median.

The trusted plan should fall below 100 seconds. This is a projected saving of at least 52 seconds.

The image workflow should take 500 to 540 seconds before further cache gains. Parallel jobs alone provide most of this saving.

Record new GitHub Actions times after the branch runs. Use the same job boundaries and successful runs for the comparison.

No post-change GitHub Actions run exists yet. All post-change Actions times in this document are projections.

## Audit stop

The audit rejected these changes because they did not save 10 seconds on the critical path:

- Shard the root unit tests. Worker tests remain the slower test lane.
- Split the Worker test pool. Local runs became slower.
- Shard type checks. It saves less than 10 seconds after Worker tests set the critical path.
- Cache manifest-first install layers with minimum cache export. BuildKit does not export these intermediate layers.
- Increase local pnpm workspace concurrency.
- Change action major versions without a measured performance reason.
