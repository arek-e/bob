# ADR 0007: Bob owns the agent loop over Pi AI

- Status: Accepted
- Date: 2026-08-11
- Scope: Bob agent runs, model providers, and Pi integration

This decision updates the Pi loop ownership statements in ADR 0003.
ADR 0001 still controls Pi OpenAI Codex authentication.

## Context

Bob needs one bounded agent loop with explicit safety rules.

The loop must own prompts, run limits, Tool authorization, output checks,
repair, and deterministic fallback behavior.

Pi offers several packages with different depths. The
`@earendil-works/pi-agent-core` package owns a ready-made Agent loop.
The `@earendil-works/pi-coding-agent` package owns a higher-level coding
session. Bob does not need either loop.

The `@earendil-works/pi-ai` package provides the lower-level model Interface.
It provides model streaming, provider registration, tool schemas, tool-call
validation, and OAuth support. Bob can use these capabilities while keeping
its policy in one Module.

## Decision

Keep `@bob/pi-agent` as Bob's deep agent Module.

It owns:

- Bob's system and repair prompts.
- Turn, Tool, time, and output limits.
- Tool authorization and sequential execution.
- Context taint and source-grounding rules.
- Structured output validation.
- One bounded output repair.
- Secret-like and prompt-injection output checks.
- Deterministic safety fallbacks.
- Provider error classification and normalized run results.

Use `@earendil-works/pi-ai` directly.

For each run, Bob creates one `pi-ai` model context. Bob appends the user
message, assistant messages, and Tool results. Bob decides when the run ends.

Pi owns provider streaming, model normalization, provider registration, and
OAuth mechanics. Bob owns the policy decisions around those operations.

Define Bob Tool wrappers from the shared Tool catalogue. Each wrapper exposes
a `pi-ai` Tool schema and one Bob-owned execution function. The wrapper
encodes Tool results as untrusted data.

Do not depend on `@earendil-works/pi-agent-core`.
Do not depend on `@earendil-works/pi-coding-agent`.
Do not add an SDK-neutral model seam while Pi remains the permanent model
library.

Keep the public Interface small:

- `createBobPiAgent`
- `runTurn`
- `getAuthStatus`
- `startDeviceLogin`

## Consequences

Pi remains a permanent production dependency.

Bob has one source of truth for loop policy and safety.

The loop can be tested without a second Pi loop hidden inside an Agent class.

A provider change uses Pi's provider support. Replacing Pi itself would be a
larger migration and is outside this decision.

The package has one deep Module. It does not add a pass-through runtime package.

## References

- [Pi AI package](https://github.com/earendil-works/pi/tree/main/packages/ai)
- [Pi provider documentation](https://pi.dev/docs/latest/providers#subscriptions)
- [Pi SDK documentation](https://pi.dev/docs/latest/sdk)
