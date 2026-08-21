# Bob Runtime

Bob Runtime is an AGPLv3-licensed private continuity assistant.

It uses iMessage through Sendblue.

The runtime uses Node, PostgreSQL, and BullMQ.

The Runtime is licensed under the GNU Affero General Public License, version 3.
See [LICENSE](LICENSE). The private Control Plane is not part of this repository.

The private `/settings` page manages owner locality and connection status.

The owner can also change locality through Bob's Sendblue conversation.

See [CONTEXT.md](CONTEXT.md) for product and architecture rules.

## Self-hosted stack

The root `compose.yaml` runs the complete portable stack. It includes PostgreSQL, Redis, OpenBao,
and an OpenTelemetry Collector. Core, Agent, and Channel use their production images.

Codex and Sendblue remain external providers. Set their credentials before startup. Set
`CODEX_CREDENTIAL_FILE` to an OpenBao-ready OAuth record when Codex credentials must be seeded.
The file must contain `type`, `access`, `refresh`, `expires`, and `accountId` fields.

Bob uses the direct `openai-codex` provider by default. To opt into the internal LiteLLM gateway,
set `BOB_PROVIDER=litellm`, `BOB_MODEL=gpt-5.4`, `BOB_ALLOWED_MODELS=gpt-5.4`,
`BOB_GATEWAY_BASE_URL`, and `BOB_GATEWAY_API_KEY`. Use Bob's LiteLLM virtual key. Do not use the
LiteLLM master key. The gateway configuration affects model requests only. Bob keeps its direct
Codex OAuth record for rollback.

Platform operators store the LiteLLM master key and Bob virtual key in separate OpenBao records.
LiteLLM stores its independent ChatGPT OAuth record on its private persistent volume. See the
[LiteLLM gateway runbook](https://github.com/teampitch/ops/blob/main/docs/litellm-gateway.md) for
credential ownership, product onboarding, and verification.

Start the stack with Docker Compose. Then open `http://127.0.0.1:8788/setup`. Enter the value of
`SETUP_TOKEN` to create the owner login.

## Local checks

Use Node 22.19 or newer and pnpm 10.19.0.

```sh
corepack enable
corepack prepare pnpm@10.19.0 --activate
pnpm install --frozen-lockfile
pnpm check
```

Use the shorter agent check during agent work:

```sh
pnpm agent:check
```

Complete core acceptance starts with one bounded conversational request from the allowlisted owner.
It requires a completed run, an `agent_reply` outbox, and delivered Sendblue status.

Do not put secrets in local environment files. Use Varlock and OpenBao.
