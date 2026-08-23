# CLI framework comparison for root/tools

Date: 2026-08-23  
Status: Research report; decision recorded below

## Recommendation

Use **Ink for the React terminal UI with a small, typed, statically registered command interface**.

This is a two-layer choice:

- The local command module owns the stable command interface: nested commands, typed options, validation, help,
  errors, and exit codes.
- Ink owns interactive rendering: status views, progress, tables, confirmations, and keyboard input.

Keep command registration static. Add each maintenance command through a reviewed import and explicit registration. Add PIM later as another command module after its scope, dry-run, approval, audit, and write rules are defined.

Commander is the fallback if the option grammar grows beyond the local parser. oclif is the strongest choice when
third-party or independently installed plugins become a real requirement. Clack is useful for prompts and task
feedback, but it should not be the command router or the React renderer. Clipanion is rejected because its official
repository has no releases and its visible commit history is stale for this project.

## Repository constraints

The repository uses Node.js >=22.19.0, pnpm, TypeScript, and Vitest. See the [root package manifest](../../package.json), [TypeScript base configuration](../../tsconfig.base.json), and [Vitest configuration](../../vitest.config.ts).

The current web UI uses Solid rather than React. See [the UI package manifest](../../apps/ui/package.json). Ink would therefore introduce React as an intentional, tools-only dependency. It should not import the web UI or share its Solid configuration.

The current pnpm workspace includes apps/* and packages/*, but not tools. See [pnpm-workspace.yaml](../../pnpm-workspace.yaml). The implementation keeps tools at the repository root with an explicit tools TypeScript configuration.

## Comparison

| Option                                                 | React terminal rendering                                                                                        | TypeScript                                                                                                                          | Command routing                                                                                        | Testing                                                                                                                                           | Extensibility                                                                                                                                                                              | Fit for Bob maintenance CLI                                                                                                                 |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| [Ink](https://github.com/vadimdemedes/ink#readme)      | Native purpose. React renderer, Yoga layout, hooks, input handling, terminal sizing, and screen-reader support. | Strong. Official scaffolding supports TypeScript.                                                                                   | Not a parser or command framework. Routing must come from another library or a small static registry.  | Strong UI testing through [ink-testing-library](https://github.com/vadimdemedes/ink-testing-library#readme), including rendered frames and stdin. | React composition; no built-in command plugin model.                                                                                                                                       | Best presentation layer, not the complete CLI foundation.                                                                                   |
| [Commander](https://github.com/tj/commander.js#readme) | None. Pair with Ink if a React UI is required.                                                                  | Good built-in declarations. Optional [extra-typings](https://github.com/commander-js/extra-typings#readme) adds stronger inference. | Complete parser with subcommands, arguments, options, hooks, help, and async actions.                  | Easy to unit test with local Command instances, parse with argument arrays, parseAsync, exitOverride, and custom output handlers.                 | Programmatic command and addCommand composition; no first-party plugin lifecycle.                                                                                                          | Good fallback if the local parser becomes too large.                                                                                        |
| [oclif](https://github.com/oclif/core#readme)          | None in the core framework. Pairing it with Ink is possible, but creates two lifecycle and output layers.       | Strong. Official generators and core APIs are TypeScript-oriented.                                                                  | Complete framework with command discovery, flags, arguments, help, hooks, and generated documentation. | First-party [@oclif/test](https://oclif.io/docs/testing/) and command-level test APIs.                                                            | Strongest plugin model. Plugins can add commands, hooks, or other plugins; official docs describe installing and discovering plugins. See [oclif plugins](https://oclif.io/docs/plugins/). | Powerful, but broader than needed. Dynamic plugin loading conflicts with a reviewed static maintenance registry unless tightly constrained. |
| [Clipanion](https://github.com/arcanis/clipanion)      | None. Pair with Ink.                                                                                            | Strong TypeScript support.                                                                                                          | Complete typed router with nested commands and validation.                                             | Direct Vitest tests are possible.                                                                                                                 | Static registration fits, but the project has no GitHub releases and its visible commit history stops on 2024-09-06.                                                                       | Rejected for a new maintenance dependency.                                                                                                  |
| [Clack](https://github.com/bombshell-dev/clack#readme) | No React renderer. It provides terminal prompt components and task feedback.                                    | Full TypeScript support.                                                                                                            | Not a general command parser or subcommand registry.                                                   | Official packages contain tests and support custom input/output streams.                                                                          | Headless primitives and customizable prompts; no command plugin system.                                                                                                                    | Good optional prompt/task layer. Do not make it the CLI architecture.                                                                       |

## Framework findings

### Ink

Ink directly matches the React requirement. Its official README describes it as React for command-line applications and documents Flexbox layout, React hooks, terminal input, output streams, resizing, focus, and screen-reader behavior. It also documents ink-testing-library for asserting rendered frames and simulating stdin.

Ink does not define a command grammar, flag schema, command discovery model, or plugin lifecycle. The official README lists routing with React Router as a recipe, which confirms that routing is an application concern. For Bob, Ink should sit below a typed command boundary rather than become the boundary.

Ink also has a terminal lifecycle. It owns input while interactive components are mounted and controls redraw behavior. Keep network and mutation logic outside React components. Render state returned by command services instead of placing database or deployment policy in the component tree.

### Commander

Commander is a complete and familiar parser. Its official README documents nested commands, options, arguments, async actions, lifecycle hooks, generated help, custom output, error handling, and parsing from an explicit argument array. It also documents local Command objects for larger programs and unit testing.

Commander supports TypeScript, but its README describes stronger option and argument inference as an optional extra-typings project. This is adequate for a small CLI, but it leaves more type and policy assembly in Bob code than Clipanion does.

Commander has composition through subcommands and addCommand, not a first-party plugin contract. That is a benefit for Bob’s reviewed registry. It also means PIM would be a normal statically registered command, not an independently installed extension.

### oclif

oclif is the most complete all-in-one framework in this comparison. The official feature list includes parsing, generated CLIs, testing helpers, auto-documentation, plugins, hooks, and JSON output. Its testing guide supports direct command execution and @oclif/test, including output capture.

Its plugin system is a real strength when a CLI needs external command packs or independently maintained extensions. It is also the main mismatch for the current maintenance-tool requirement. Bob’s architecture requires reviewed static deployment profiles and does not need runtime discovery. If oclif is selected, disable or tightly constrain user-installed plugins and keep the production command set statically reviewed.

oclif does not provide React rendering in its core. Pairing oclif with Ink would require a deliberate output adapter so that command lifecycle, stdout capture, errors, and Ink rendering do not compete.

### Clipanion — rejected

Clipanion is a typed command framework with no runtime dependencies. Its official README describes nested commands,
option inference, validation, execution contexts, error handling, and state-machine parsing.

The feature fit is good, but maintenance risk is not. The official GitHub releases page says that there are no
releases, and the official commit history shows its latest visible commits in September 2024. That is not a good
foundation for a new production maintenance tool in 2026. Keep the local typed registry until a maintained parser is
needed.

The official documentation does not present a framework-specific test helper. Its repository contains TypeScript specs and snapshots, so the practical approach is direct command tests with the repository’s Vitest setup. Keep command execution injectable so tests can provide fake services, output streams, and a non-production environment.

### Clack

Clack is a prompt and terminal-feedback toolkit. Its official documentation separates @clack/prompts high-level components from @clack/core headless primitives. It provides text, password, selection, confirmation, autocomplete, task, spinner, progress, notes, and custom stream support.

Clack has strong TypeScript ergonomics and is a good choice for a short confirmation flow or a sequential maintenance task. It does not replace command parsing, typed subcommand routing, or a plugin registry. It also does not provide React rendering. Mixing Clack prompts with Ink is possible, but both libraries interact with terminal input and output; one should own the interactive session at a time.

## Fit against Bob’s review model

The maintenance CLI needs a narrow interface around reviewed command modules:

1. Parse a known command path and validated options.
2. Resolve an explicit command implementation.
3. Run domain services with injected dependencies.
4. Render progress and results.
5. Return a predictable exit code.

The registry should be static. A future PIM command should be added by:

- adding a TypeScript command module under tools/maintenance/;
- registering it in one reviewed command list;
- adding unit tests for parsing, authorization, dry-run, and failure paths;
- adding an interactive Ink view only for presentation;
- keeping PIM mutation policy in application/domain services;
- requiring explicit scope, preview output, confirmation, and audit fields for writes.

This avoids oclif’s plugin discovery and avoids treating Ink components as the place where command authorization or
production mutation rules live.

## Proposed root/tools shape

The implementation uses this structure:

```text
tools/
  cli.tsx                  # Ink root and process boundary
  tsconfig.json            # tools-only TypeScript/JSX configuration
  maintenance/
    cli.ts                 # typed registry and execution seam
    app.tsx                # Ink root component
    production-data.ts     # first reviewed maintenance command
    pim.ts                 # future; add only after its write contract exists
  test/
    maintenance-cli.test.ts
    maintenance-app.test.tsx
```

The command modules should call existing application services or private Runtime APIs. They should not contain direct production SQL, secret values, or deployment credentials. Non-interactive output should remain available for CI and incident logs; Ink should enhance interactive mode rather than become the only output path.

## Decision summary

| Decision                         | Result                                                     |
| -------------------------------- | ---------------------------------------------------------- |
| React terminal UI                | Ink                                                        |
| Typed command routing            | Small local static registry                                |
| Optional prompt helper           | Clack only when Ink does not own the same terminal session |
| Simpler fallback                 | Commander plus Ink                                         |
| Plugin-heavy alternative         | oclif, only if external plugins become a requirement       |
| Static reviewed command registry | Required                                                   |
| PIM now                          | Not implemented; reserve the command seam                  |

## Sources

All framework claims in this report use first-party documentation or source repositories:

- [Ink README](https://github.com/vadimdemedes/ink#readme)
- [Ink testing library README](https://github.com/vadimdemedes/ink-testing-library#readme)
- [Commander README](https://github.com/tj/commander.js#readme)
- [Commander extra typings](https://github.com/commander-js/extra-typings#readme)
- [oclif core README](https://github.com/oclif/core#readme)
- [oclif features](https://oclif.io/docs/features/)
- [oclif testing](https://oclif.io/docs/testing/)
- [oclif plugins](https://oclif.io/docs/plugins/)
- [Clipanion overview](https://mael.dev/clipanion/)
- [Clipanion documentation](https://mael.dev/clipanion/docs/)
- [Clipanion validation](https://mael.dev/clipanion/docs/validation/)
- [Clipanion official tests](https://github.com/arcanis/clipanion/tree/master/tests)
- [Clipanion releases](https://github.com/arcanis/clipanion/releases)
- [Clipanion commit history](https://github.com/arcanis/clipanion/commits/master)
- [Clack repository README](https://github.com/bombshell-dev/clack#readme)
- [Clack getting started](https://bomb.sh/docs/clack/basics/getting-started/)
- [Clack prompts](https://bomb.sh/docs/clack/packages/prompts/)
