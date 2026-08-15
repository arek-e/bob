# Architecture decision index

This directory contains Bob's current architecture decisions.

Read `CONTEXT.md` first. Use this index when a change reaches an architecture seam.

Git history keeps removed plans and superseded implementation details.

| ADR                                                 | Decision                                                     | Status                    |
| --------------------------------------------------- | ------------------------------------------------------------ | ------------------------- |
| [0001](0001-pi-openai-codex-auth.md)                | Store Pi OpenAI Codex OAuth credentials in OpenBao           | Accepted                  |
| [0002](0002-sendblue-agent-channel.md)              | Put a durable Sendblue channel before Pi                     | Accepted                  |
| [0003](0003-agent-runtime-and-repository-seams.md)  | Use one Bob agent runtime with domain-owned workflows        | Accepted                  |
| [0004](0004-alchemy-effect-drizzle.md)              | Use Alchemy, Effect v4, and Drizzle v1 RC                    | Accepted                  |
| [0005](0005-varlock-environment-contracts.md)       | Use Varlock for environment contracts                        | Accepted                  |
| [0006](0006-personal-context-cache-policy.md)       | Personal context cache policy                                | Accepted                  |
| [0007](0007-bob-owned-pi-ai-loop.md)                | Bob owns the agent loop over Pi AI                           | Accepted                  |
| [0008](0008-effect-telemetry-and-trace-contract.md) | Use Effect telemetry Layers and one trace contract           | Accepted                  |
| [0009](0009-coolify-private-runtime.md)             | Use Coolify for the self-hosted private runtime              | Accepted for self-hosting |
| [0010](0010-revisioned-conversation-turns.md)       | Use revisioned conversation turns for message steering       | Accepted                  |
| [0011](0011-evaluation-storage.md)                  | Evaluation records and artifacts                             | Accepted                  |
| [0012](0012-model-directed-capability-selection.md) | Model-directed capability selection                          | Accepted                  |
| [0013](0013-shared-connections-gateway.md)          | Use one shared Connections Gateway for managed Bob Instances | Accepted                  |
| [0014](0014-portable-runner-deployment-contract.md) | Publish portable deployment contracts for Bob Runner         | Accepted                  |
| [0015](0015-managed-instance-activation.md)         | Support managed Instance activation and channel routing      | Accepted                  |
| [0016](0016-domain-neutral-core-profile.md)         | Compose a domain-neutral core through static profiles        | Accepted                  |

ADR 0009 does not define managed orchestration. ADRs 0013 through 0015 own that design.
